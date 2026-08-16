import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../storage/event-bus.js";
import type { CharacterLoader } from "./character-loader.js";
import type {
	CharacterOnboardingFlow,
	CharacterOnboardingStep,
	OnboardingStateData,
} from "./onboarding-schema.js";
import { OnboardingStateDataSchema } from "./onboarding-schema.js";

export type OnboardingStatus = "active" | "complete";

export interface OnboardingStateRow {
	status: OnboardingStatus;
	currentStepId?: string;
	stateData: OnboardingStateData;
}

interface PersistedOnboardingRow {
	state: string;
	state_json: string;
}

interface CreatedConversation {
	conversationId: string;
	sceneTitle: string;
	title: string;
}

const UPSERT_STATE_SQL = `
	INSERT INTO onboarding_state (companion_id, state, state_json, updated_at)
	VALUES (?, ?, ?, datetime('now'))
	ON CONFLICT(companion_id) DO UPDATE SET
		state = excluded.state,
		state_json = excluded.state_json,
		updated_at = datetime('now')
`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Host-owned execution engine for a role-defined onboarding flow. The role
 * package declares presentation, valid answers and a restricted effect
 * vocabulary; this class validates, persists and executes those effects.
 */
export class FirstMeetingMachine {
	constructor(
		private readonly db: DatabaseSync,
		private readonly eventBus: EventBus,
		private readonly characterLoader: CharacterLoader,
	) {}

	getState(companionId: string): OnboardingStateRow {
		const flow = this.flow(companionId);
		const persisted = this.readPersisted(companionId);
		const stateData = this.normalizeStateData(persisted?.state_json, flow);

		if (persisted?.state === "voice_ready") {
			// The retired voice gate never represented a user request. Complete
			// existing rows atomically instead of exposing a dead-end state.
			return this.persistTransition(companionId, flow, "complete", stateData);
		}
		if (persisted?.state === "complete") {
			if (persisted.state_json !== JSON.stringify(stateData)) {
				this.persist(companionId, "complete", stateData);
			}
			return { status: "complete", stateData };
		}

		const currentStep = flow.steps.find((step) => step.id === persisted?.state) ?? flow.steps[0];
		if (!currentStep)
			throw new Error(`character package ${companionId}: first_meeting has no steps`);
		if (persisted?.state !== currentStep.id || persisted.state_json !== JSON.stringify(stateData)) {
			this.persist(companionId, currentStep.id, stateData);
		}
		return { status: "active", currentStepId: currentStep.id, stateData };
	}

	submit(companionId: string, stepId: string, answer: unknown): OnboardingStateRow {
		const current = this.getState(companionId);
		if (current.status !== "active" || current.currentStepId !== stepId) {
			throw { kind: "conflict", reason: "stale_onboarding_step" };
		}

		const flow = this.flow(companionId);
		const index = flow.steps.findIndex((step) => step.id === stepId);
		const step = flow.steps[index];
		if (!step) throw { kind: "not_found", reason: "onboarding_step_not_found" };
		const value = this.validateAnswer(step, answer);
		const nextData = this.applyAnswer(step, value, current.stateData);
		const nextStep = flow.steps[index + 1];
		return this.persistTransition(companionId, flow, nextStep?.id ?? "complete", nextData);
	}

	setRelationshipMemory(companionId: string, enabled: boolean): OnboardingStateRow {
		const current = this.getState(companionId);
		const flow = this.flow(companionId);
		const step = flow.steps.find((candidate) =>
			candidate.effects?.some((effect) => effect.type === "relationship.memory"),
		);
		if (!step || step.kind !== "choice") {
			throw { kind: "unavailable", reason: "relationship_memory_not_configured" };
		}
		const effect = step.effects?.find((candidate) => candidate.type === "relationship.memory");
		if (!effect || effect.type !== "relationship.memory") {
			throw { kind: "unavailable", reason: "relationship_memory_not_configured" };
		}
		const value = enabled
			? effect.enabled_when
			: step.choices.find((choice) => choice.value !== effect.enabled_when)?.value;
		if (!value)
			throw new Error(`character package ${companionId}: memory choice has no disabled value`);

		const stateData = this.applyAnswer(step, value, current.stateData);
		return this.persistTransition(
			companionId,
			flow,
			current.status === "complete" ? "complete" : (current.currentStepId ?? step.id),
			stateData,
		);
	}

	private flow(companionId: string): CharacterOnboardingFlow {
		const character = this.characterLoader.load(companionId);
		if (!character) throw { kind: "unavailable", reason: "character_package_missing" };
		return character.character.first_meeting;
	}

	private readPersisted(companionId: string): PersistedOnboardingRow | undefined {
		return this.db
			.prepare("SELECT state, state_json FROM onboarding_state WHERE companion_id = ?")
			.get(companionId) as PersistedOnboardingRow | undefined;
	}

	private normalizeStateData(
		serialized: string | undefined,
		flow: CharacterOnboardingFlow,
	): OnboardingStateData {
		const value: unknown = serialized ? JSON.parse(serialized) : {};
		const source = isRecord(value) ? value : {};
		const parsedState = OnboardingStateDataSchema.safeParse(source);
		if (!parsedState.success && source.schema_version !== undefined) {
			throw parsedState.error;
		}
		const storedAnswers = parsedState.success ? parsedState.data.answers : {};
		const legacyName = typeof source.name === "string" ? source.name : undefined;
		const legacyRelation = typeof source.relation === "string" ? source.relation : undefined;
		const legacyMemory =
			typeof source.memoryEnabled === "boolean" ? source.memoryEnabled : undefined;
		const answers: Record<string, string> = {};
		const decisions: OnboardingStateData["decisions"] = {};

		for (const step of flow.steps) {
			if (step.kind === "acknowledge") continue;
			let answer = storedAnswers[step.answer_key];
			if (answer === undefined) {
				if (step.effects?.some((effect) => effect.type === "identity.nickname"))
					answer = legacyName;
				if (step.effects?.some((effect) => effect.type === "relationship.kind"))
					answer = legacyRelation;
				const memoryEffect = step.effects?.find((effect) => effect.type === "relationship.memory");
				if (
					step.kind === "choice" &&
					memoryEffect?.type === "relationship.memory" &&
					legacyMemory !== undefined
				) {
					answer = legacyMemory
						? memoryEffect.enabled_when
						: step.choices.find((choice) => choice.value !== memoryEffect.enabled_when)?.value;
				}
			}
			if (!this.isValidStoredAnswer(step, answer)) continue;
			answers[step.answer_key] = answer;
			for (const effect of step.effects ?? []) {
				if (effect.type === "relationship.kind") decisions.relationship_kind = answer;
				if (effect.type === "relationship.memory") {
					decisions.relationship_memory_enabled = answer === effect.enabled_when;
				}
			}
		}

		return {
			schema_version: 1,
			flow_version: flow.version,
			answers,
			decisions,
		};
	}

	private isValidStoredAnswer(
		step: Exclude<CharacterOnboardingStep, { kind: "acknowledge" }>,
		value: unknown,
	): value is string {
		if (typeof value !== "string") return false;
		if (step.kind === "text") {
			const length = value.trim().length;
			return length >= step.min_length && length <= step.max_length;
		}
		return step.choices.some((choice) => choice.value === value);
	}

	private validateAnswer(step: CharacterOnboardingStep, answer: unknown): string | undefined {
		if (step.kind === "acknowledge") {
			if (answer !== undefined)
				throw { kind: "invalid_request", reason: "onboarding_answer_unexpected" };
			return undefined;
		}
		if (typeof answer !== "string")
			throw { kind: "invalid_request", reason: "onboarding_answer_required" };
		const value = step.kind === "text" ? answer.trim() : answer;
		if (!this.isValidStoredAnswer(step, value)) {
			throw { kind: "invalid_request", reason: "onboarding_answer_invalid" };
		}
		return value;
	}

	private applyAnswer(
		step: CharacterOnboardingStep,
		answer: string | undefined,
		stateData: OnboardingStateData,
	): OnboardingStateData {
		const answers = { ...stateData.answers };
		const decisions = { ...stateData.decisions };
		if (step.kind !== "acknowledge" && answer !== undefined) {
			answers[step.answer_key] = answer;
			for (const effect of step.effects ?? []) {
				if (effect.type === "relationship.kind") decisions.relationship_kind = answer;
				if (effect.type === "relationship.memory") {
					decisions.relationship_memory_enabled = answer === effect.enabled_when;
				}
			}
		}
		return {
			schema_version: 1,
			flow_version: stateData.flow_version,
			answers,
			decisions,
		};
	}

	private persistTransition(
		companionId: string,
		flow: CharacterOnboardingFlow,
		nextState: string,
		stateData: OnboardingStateData,
	): OnboardingStateRow {
		const step = flow.steps.find((candidate) => candidate.id === nextState);
		if (nextState !== "complete" && !step) {
			throw new Error(`character package ${companionId}: unknown onboarding step ${nextState}`);
		}
		let nicknameValue: string | undefined;
		for (const candidate of flow.steps) {
			if (
				candidate.kind === "text" &&
				candidate.effects?.some((effect) => effect.type === "identity.nickname")
			) {
				nicknameValue = stateData.answers[candidate.answer_key];
				break;
			}
		}
		let conversation: CreatedConversation | undefined;

		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (nicknameValue !== undefined) {
				this.db
					.prepare("UPDATE companion_identity SET nickname = ? WHERE id = ?")
					.run(nicknameValue, companionId);
			}
			this.persist(companionId, nextState, stateData);
			if (nextState === "complete") conversation = this.seedConversation(companionId, flow);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw { kind: "internal", reason: error instanceof Error ? error.message : String(error) };
		}

		const row =
			nextState === "complete"
				? { status: "complete" as const, stateData }
				: { status: "active" as const, currentStepId: nextState, stateData };
		this.eventBus.publish("onboarding.state_changed", row);
		if (conversation) this.eventBus.publish("conversation.created", conversation);
		return row;
	}

	private persist(companionId: string, state: string, stateData: OnboardingStateData): void {
		this.db.prepare(UPSERT_STATE_SQL).run(companionId, state, JSON.stringify(stateData));
	}

	private seedConversation(
		companionId: string,
		flow: CharacterOnboardingFlow,
	): CreatedConversation | undefined {
		const existing = this.db
			.prepare("SELECT id FROM conversations WHERE companion_id = ? LIMIT 1")
			.get(companionId) as { id: string } | undefined;
		if (existing) return undefined;
		const character = this.characterLoader.load(companionId);
		if (!character) throw { kind: "unavailable", reason: "character_package_missing" };
		const conversationId = randomUUID();
		const title = flow.completion.conversation_title;
		const sceneTitle = character.character.scene_title;
		this.db
			.prepare(
				"INSERT INTO conversations (id, companion_id, title, scene_title) VALUES (?, ?, ?, ?)",
			)
			.run(conversationId, companionId, title, sceneTitle);
		this.db
			.prepare(
				"INSERT INTO branches (id, conversation_id, parent_branch_id, label, adopted) VALUES (?, ?, NULL, 'main', 1)",
			)
			.run(randomUUID(), conversationId);
		return { conversationId, sceneTitle, title };
	}
}
