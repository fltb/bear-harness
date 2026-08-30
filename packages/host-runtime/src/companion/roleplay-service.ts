import { eq } from "drizzle-orm";
import jsonPatch from "fast-json-patch";
import type { AppDatabase } from "../storage/database.js";
import { onboardingState } from "../storage/schema.js";
import type { CharacterPackage } from "./character-loader.js";
import { CompanionStore } from "./companion-store.js";
import { OnboardingStateDataSchema } from "./onboarding-schema.js";
import type { RoleplayCondition, RoleplayValue } from "./roleplay-schema.js";
import type { CharacterStateService } from "./state-service.js";

const { getValueByPointer } = jsonPatch;

export interface RoleplayProjection {
	values: Record<string, RoleplayValue>;
	state: Record<string, unknown>;
	unlocked: string[];
}

/**
 * Read-only compatibility projection for package variables and presentation
 * eligibility. Story progression is normal character state written through
 * host_state; this service has no transition or user-choice execution path.
 */
export class RoleplayService {
	private readonly companionStore: CompanionStore;

	constructor(
		private readonly db: AppDatabase,
		private readonly characterState?: CharacterStateService,
		companionStore?: CompanionStore,
	) {
		this.companionStore = companionStore ?? new CompanionStore(db);
	}

	project(character: CharacterPackage, conversationId?: string): RoleplayProjection {
		const values = Object.fromEntries(
			character.roleplay.variables.map((variable) => [variable.id, variable.initial]),
		) as Record<string, RoleplayValue>;
		const onboarding = this.db
			.select({ stateData: onboardingState.stateJson })
			.from(onboardingState)
			.where(eq(onboardingState.companionId, character.id))
			.get();
		const overrides = onboarding
			? (OnboardingStateDataSchema.parse(onboarding.stateData).decisions.roleplay_initial_values ??
				{})
			: {};
		for (const variable of character.roleplay.variables) {
			const override = overrides[variable.id];
			if (override !== undefined && validInitialOverride(variable, override))
				values[variable.id] = override;
		}
		const unlocked = conversationId
			? this.companionStore.snapshot(character, conversationId).collection.unlocks
			: [];
		const state =
			conversationId && this.characterState
				? this.characterState.project(character.id, conversationId, character.state).document
				: {};
		return { values, state, unlocked };
	}

	isEligible(
		character: CharacterPackage,
		conversationId: string,
		condition?: RoleplayCondition,
		stateOverride?: Record<string, unknown>,
	): boolean {
		if (!condition) return true;
		const projection = this.project(character, conversationId);
		return evaluateCondition(condition, {
			...projection,
			state: stateOverride ?? projection.state,
		});
	}

	presentation(
		character: CharacterPackage,
		conversationId?: string,
	): {
		conversationId?: string;
		mediaId?: string;
		ambientMediaId?: string;
		choiceSetId?: string;
		seenMediaIds: string[];
	} {
		if (!conversationId) return { seenMediaIds: [] };
		const snapshot = this.companionStore.snapshot(character, conversationId);
		const mediaId =
			snapshot.display.surfaces.inline ?? snapshot.display.surfaces.modal ?? undefined;
		const choiceSetId = snapshot.display.surfaces.choices ?? undefined;
		const choiceSet = choiceSetId
			? character.roleplay.choice_sets.find((set) => set.id === choiceSetId)
			: undefined;
		const eligibleChoiceSetId =
			choiceSet &&
			(!this.characterState || this.isEligible(character, conversationId, choiceSet.when))
				? choiceSet.id
				: undefined;
		return {
			conversationId,
			...(mediaId ? { mediaId } : {}),
			...(snapshot.display.surfaces.ambient
				? { ambientMediaId: snapshot.display.surfaces.ambient }
				: {}),
			...(eligibleChoiceSetId ? { choiceSetId: eligibleChoiceSetId } : {}),
			seenMediaIds: snapshot.collection.seenMediaIds,
		};
	}

	resetUnlocks(companionId: string): void {
		this.companionStore.resetUnlocks(companionId);
	}
}

function evaluateCondition(condition: RoleplayCondition, state: RoleplayProjection): boolean {
	if ("all" in condition) return condition.all.every((item) => evaluateCondition(item, state));
	if ("any" in condition) return condition.any.some((item) => evaluateCondition(item, state));
	if ("not" in condition) return !evaluateCondition(condition.not, state);
	if ("unlocked" in condition) return state.unlocked.includes(condition.unlocked);
	if ("state" in condition) {
		const value = safeValueByPointer(state.state, condition.state);
		if ("equals" in condition)
			return Array.isArray(condition.equals)
				? condition.equals.some((candidate) => Object.is(value, candidate))
				: Object.is(value, condition.equals);
		if (typeof value !== "number") return false;
		if (condition.operator === "gt") return value > condition.value;
		if (condition.operator === "gte") return value >= condition.value;
		if (condition.operator === "lt") return value < condition.value;
		return value <= condition.value;
	}
	if ("equals" in condition) return state.values[condition.variable] === condition.equals;
	const value = state.values[condition.variable];
	if (typeof value !== "number") return false;
	if (condition.operator === "gt") return value > condition.value;
	if (condition.operator === "gte") return value >= condition.value;
	if (condition.operator === "lt") return value < condition.value;
	return value <= condition.value;
}

function safeValueByPointer(state: object, pointer: string): unknown {
	try {
		return getValueByPointer(state, pointer);
	} catch {
		return undefined;
	}
}

function validInitialOverride(
	variable: CharacterPackage["roleplay"]["variables"][number],
	value: RoleplayValue,
): boolean {
	if (variable.type === "number") return typeof value === "number";
	if (variable.type === "boolean") return typeof value === "boolean";
	if (variable.type === "string") return typeof value === "string";
	return typeof value === "string" && variable.values?.includes(value) === true;
}
