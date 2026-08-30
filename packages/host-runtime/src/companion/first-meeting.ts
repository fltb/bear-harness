import { eq } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import { companionIdentity, conversations, onboardingState } from "../storage/schema.js";
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
	stateData: unknown;
}

export interface CreatedConversation {
	conversationId: string;
	title: string;
}
export type OnboardingConversationCommit = (
	transaction: Pick<AppDatabase, "insert" | "update">,
) => void;
export interface OnboardingConversationCreationInput {
	companionId: string;
	title: string;
	onCommit: OnboardingConversationCommit;
}

export type OnboardingConversationFactory = (
	input: OnboardingConversationCreationInput,
) => CreatedConversation;

/**
 * Host-owned execution engine for a role-defined onboarding flow. The role
 * package declares presentation, valid answers and a restricted effect
 * vocabulary; this class validates, persists and executes those effects.
 */
export class FirstMeetingMachine {
	private onConversationCreated?: (companionId: string, conversationId: string) => void;
	private conversationFactory?: OnboardingConversationFactory;

	constructor(
		private readonly db: AppDatabase,
		private readonly eventBus: EventBus,
		private readonly characterLoader: CharacterLoader,
	) {}

	setConversationFactory(factory: OnboardingConversationFactory): void {
		this.conversationFactory = factory;
	}

	setConversationCreatedHandler(
		handler: (companionId: string, conversationId: string) => void,
	): void {
		this.onConversationCreated = handler;
	}

	/** Reads never normalize persisted rows or trigger lifecycle transitions. */
	getState(companionId: string): OnboardingStateRow {
		const flow = this.flow(companionId);
		const persisted = this.readPersisted(companionId);
		const stateData = this.normalizeStateData(persisted?.stateData, flow);
		if (persisted?.state === "complete") return { status: "complete", stateData };
		const step = flow.steps.find((step) => step.id === persisted?.state) ?? flow.steps[0];
		if (!step) throw new Error(`character package ${companionId}: first_meeting has no steps`);
		return { status: "active", currentStepId: step.id, stateData };
	}

	/** Called only during initialization or an explicit command. */
	initialize(companionId: string): OnboardingStateRow {
		const flow = this.flow(companionId);
		const persisted = this.readPersisted(companionId);
		const stateData = this.normalizeStateData(persisted?.stateData, flow);

		if (persisted?.state === "complete") {
			if (JSON.stringify(persisted.stateData) !== JSON.stringify(stateData)) {
				this.persist(companionId, "complete", stateData);
			}
			return { status: "complete", stateData };
		}

		const currentStep = flow.steps.find((step) => step.id === persisted?.state) ?? flow.steps[0];
		if (!currentStep)
			throw new Error(`character package ${companionId}: first_meeting has no steps`);
		if (
			persisted?.state !== currentStep.id ||
			JSON.stringify(persisted.stateData) !== JSON.stringify(stateData)
		) {
			this.persist(companionId, currentStep.id, stateData);
		}
		return { status: "active", currentStepId: currentStep.id, stateData };
	}

	submit(companionId: string, stepId: string, answer: unknown): OnboardingStateRow {
		const current = this.initialize(companionId);
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
		const current = this.initialize(companionId);
		const flow = this.flow(companionId);
		return this.persistTransition(
			companionId,
			flow,
			current.status === "complete" ? "complete" : (current.currentStepId ?? "complete"),
			{
				...current.stateData,
				decisions: { ...current.stateData.decisions, relationship_memory_enabled: enabled },
			},
		);
	}

	setConversationHistoryRead(companionId: string, enabled: boolean): OnboardingStateRow {
		const current = this.initialize(companionId);
		const flow = this.flow(companionId);
		return this.persistTransition(
			companionId,
			flow,
			current.status === "complete" ? "complete" : (current.currentStepId ?? "complete"),
			{
				...current.stateData,
				decisions: { ...current.stateData.decisions, conversation_history_read_enabled: enabled },
			},
		);
	}

	private flow(companionId: string): CharacterOnboardingFlow {
		const character = this.characterLoader.load(companionId);
		if (!character) throw { kind: "unavailable", reason: "character_package_missing" };
		return character.character.first_meeting;
	}

	private readPersisted(companionId: string): PersistedOnboardingRow | undefined {
		return this.db
			.select({ state: onboardingState.state, stateData: onboardingState.stateJson })
			.from(onboardingState)
			.where(eq(onboardingState.companionId, companionId))
			.get();
	}

	private normalizeStateData(
		serialized: unknown,
		flow: CharacterOnboardingFlow,
	): OnboardingStateData {
		if (serialized === undefined) {
			return {
				schema_version: 1,
				flow_version: flow.version,
				answers: {},
				decisions: {
					relationship_memory_enabled: true,
					conversation_history_read_enabled: true,
					roleplay_initial_values: {},
				},
			};
		}
		const parsedState = OnboardingStateDataSchema.safeParse(serialized);
		if (!parsedState.success) throw parsedState.error;
		if (parsedState.data.flow_version !== flow.version) {
			throw new Error(
				`character onboarding state version ${parsedState.data.flow_version} does not match flow version ${flow.version}`,
			);
		}
		const storedAnswers = parsedState.data.answers;
		const answers: Record<string, string> = {};
		const decisions: OnboardingStateData["decisions"] = {
			relationship_memory_enabled: parsedState.data.decisions.relationship_memory_enabled ?? true,
			conversation_history_read_enabled:
				parsedState.data.decisions.conversation_history_read_enabled ?? true,
			roleplay_initial_values: parsedState.data.decisions.roleplay_initial_values ?? {},
		};
		for (const step of flow.steps) {
			if (step.kind === "acknowledge") continue;
			const answer = storedAnswers[step.answer_key];
			if (!this.isValidStoredAnswer(step, answer)) continue;
			answers[step.answer_key] = answer;
			for (const effect of step.effects ?? []) {
				const value = effect.type === "identity.nickname" ? undefined : effect.values[answer];
				if (effect.type === "setting.set" && typeof value === "boolean") {
					decisions[effect.setting] = value;
				}
				if (effect.type === "roleplay.initial" && value !== undefined) {
					decisions.roleplay_initial_values = {
						...decisions.roleplay_initial_values,
						[effect.variable]: value,
					};
				}
			}
		}
		if (typeof parsedState.data.decisions.relationship_memory_enabled === "boolean") {
			decisions.relationship_memory_enabled =
				parsedState.data.decisions.relationship_memory_enabled;
		}
		if (typeof parsedState.data.decisions.conversation_history_read_enabled === "boolean") {
			decisions.conversation_history_read_enabled =
				parsedState.data.decisions.conversation_history_read_enabled;
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
				const value = effect.type === "identity.nickname" ? undefined : effect.values[answer];
				if (effect.type === "setting.set" && typeof value === "boolean") {
					decisions[effect.setting] = value;
				}
				if (effect.type === "roleplay.initial" && value !== undefined) {
					decisions.roleplay_initial_values = {
						...decisions.roleplay_initial_values,
						[effect.variable]: value,
					};
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

		try {
			if (nextState === "complete") {
				const existing = this.db
					.select({ id: conversations.id })
					.from(conversations)
					.where(eq(conversations.companionId, companionId))
					.limit(1)
					.get();
				if (existing) {
					this.db.transaction((transaction) => {
						if (nicknameValue !== undefined) {
							transaction
								.update(companionIdentity)
								.set({ nickname: nicknameValue })
								.where(eq(companionIdentity.id, companionId))
								.run();
						}
						this.persist(companionId, nextState, stateData, transaction);
					});
				} else {
					const character = this.characterLoader.load(companionId);
					if (!character) throw { kind: "unavailable", reason: "character_package_missing" };
					if (!this.conversationFactory)
						throw new Error("onboarding conversation factory is not configured");
					conversation = this.conversationFactory({
						companionId,
						title: flow.completion.conversation_title,
						onCommit: (transaction) => {
							if (nicknameValue !== undefined) {
								transaction
									.update(companionIdentity)
									.set({ nickname: nicknameValue })
									.where(eq(companionIdentity.id, companionId))
									.run();
							}
							this.persist(companionId, nextState, stateData, transaction);
						},
					});
				}
			} else {
				this.db.transaction((transaction) => {
					if (nicknameValue !== undefined) {
						transaction
							.update(companionIdentity)
							.set({ nickname: nicknameValue })
							.where(eq(companionIdentity.id, companionId))
							.run();
					}
					this.persist(companionId, nextState, stateData, transaction);
				});
			}
		} catch (error) {
			throw { kind: "internal", reason: error instanceof Error ? error.message : String(error) };
		}

		const row =
			nextState === "complete"
				? { status: "complete" as const, stateData }
				: { status: "active" as const, currentStepId: nextState, stateData };
		this.eventBus.publish("onboarding.state_changed", row);
		if (conversation) {
			this.onConversationCreated?.(companionId, conversation.conversationId);
			this.eventBus.publish("conversation.created", conversation);
		}
		return row;
	}

	private persist(
		companionId: string,
		state: string,
		stateData: OnboardingStateData,
		db: Pick<AppDatabase, "insert"> = this.db,
	): void {
		db.insert(onboardingState)
			.values({ companionId, state, stateJson: stateData })
			.onConflictDoUpdate({
				target: onboardingState.companionId,
				set: { state, stateJson: stateData, updatedAt: new Date().toISOString() },
			})
			.run();
	}
}
