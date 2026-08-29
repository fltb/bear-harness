import { parseKnownDomainEvent } from "@bear-harness/protocol/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { events, onboardingState, roleplayEvents, roleplayUnlocks } from "../storage/schema.js";
import type { CharacterPackage } from "./character-loader.js";
import { OnboardingStateDataSchema } from "./onboarding-schema.js";
import type { RoleplayCondition, RoleplayEffect, RoleplayValue } from "./roleplay-schema.js";
import type { CharacterStateOperation } from "./state-schema.js";
import type { CharacterStateService } from "./state-service.js";

export interface RoleplayProjection {
	values: Record<string, RoleplayValue>;
	state: Record<string, unknown>;
	unlocked: string[];
}

export class RoleplayService {
	constructor(
		private readonly db: AppDatabase,
		private readonly characterState?: CharacterStateService,
	) {}

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
		const rows = this.db
			.select({
				effects: roleplayEvents.effectsJson,
				conversationId: roleplayEvents.conversationId,
			})
			.from(roleplayEvents)
			.where(eq(roleplayEvents.companionId, character.id))
			.all();
		for (const row of rows)
			this.applyEffects(
				values,
				row.effects as RoleplayEffect[],
				character,
				conversationId,
				row.conversationId ?? undefined,
			);
		const unlocked = this.db
			.select({ id: roleplayUnlocks.unlockableId })
			.from(roleplayUnlocks)
			.where(eq(roleplayUnlocks.companionId, character.id))
			.all()
			.map((row) => row.id);
		const state =
			conversationId && this.characterState
				? this.characterState.project(character.id, conversationId, character.state).values
				: {};
		return { values, state, unlocked };
	}

	isEligible(
		character: CharacterPackage,
		conversationId: string,
		condition?: RoleplayCondition,
	): boolean {
		return !condition || evaluateCondition(condition, this.project(character, conversationId));
	}

	/** Presentation is reconstructed from its persisted Host events, including dismissals. */
	presentation(
		character: CharacterPackage,
		conversationId?: string,
	): {
		conversationId?: string;
		mediaId?: string;
		ambientMediaId?: string;
		choiceSetId?: string;
	} {
		if (!conversationId) return {};
		const result: {
			conversationId: string;
			mediaId?: string;
			ambientMediaId?: string;
			choiceSetId?: string;
		} = { conversationId };
		const rows = this.db
			.select({ seq: events.seq, kind: events.kind, payload: events.payload })
			.from(events)
			.where(
				and(
					inArray(events.kind, [
						"roleplay.media_presented",
						"roleplay.media_dismissed",
						"roleplay.choices_presented",
						"roleplay.choices_dismissed",
					]),
					sql`json_extract(${events.payload}, '$.conversationId') = ${conversationId}`,
				),
			)
			.orderBy(asc(events.seq))
			.all();
		for (const row of rows) {
			const event = parseKnownDomainEvent(row);
			if (!event) continue;
			if (event.kind === "roleplay.media_presented") {
				const media = character.roleplay.media.find((item) => item.id === event.payload.mediaId);
				if (media?.presentation === "ambient") result.ambientMediaId = media.id;
				else if (media) result.mediaId = media.id;
			} else if (event.kind === "roleplay.media_dismissed") {
				if (result.mediaId === event.payload.mediaId) delete result.mediaId;
				if (result.ambientMediaId === event.payload.mediaId) delete result.ambientMediaId;
			} else if (event.kind === "roleplay.choices_presented") {
				if (character.roleplay.choice_sets.some((item) => item.id === event.payload.choiceSetId))
					result.choiceSetId = event.payload.choiceSetId;
			} else if (event.kind === "roleplay.choices_dismissed") delete result.choiceSetId;
		}
		return result;
	}

	trigger(input: {
		character: CharacterPackage;
		eventId: string;
		conversationId?: string;
		piSessionId?: string;
		sourceNativeEntryId?: string;
		dedupeKey: string;
	}): RoleplayProjection {
		const event = input.character.roleplay.events.find(
			(candidate) => candidate.id === input.eventId,
		);
		if (!event) throw { kind: "not_found", reason: "roleplay_event_not_found" };
		const id = input.dedupeKey;
		const existing = this.db
			.select({ id: roleplayEvents.id })
			.from(roleplayEvents)
			.where(eq(roleplayEvents.id, id))
			.get();
		if (existing) return this.project(input.character, input.conversationId);
		const current = this.project(input.character, input.conversationId);
		if (event.when && !evaluateCondition(event.when, current))
			throw { kind: "conflict", reason: "roleplay_event_condition_failed" };
		this.db.transaction((transaction) => {
			transaction
				.insert(roleplayEvents)
				.values({
					id,
					companionId: input.character.id,
					conversationId: input.conversationId,
					piSessionId: input.piSessionId,
					sourceNativeEntryId: input.sourceNativeEntryId,
					eventId: event.id,
					effectsJson: event.effects,
				})
				.onConflictDoNothing()
				.run();
			for (const effect of event.effects)
				if (effect.type === "unlock")
					transaction
						.insert(roleplayUnlocks)
						.values({
							companionId: input.character.id,
							unlockableId: effect.unlockable,
							sourceEventId: id,
						})
						.onConflictDoNothing()
						.run();
			const stateEffects = event.effects.filter(
				(effect): effect is Extract<RoleplayEffect, { type: "state" }> => effect.type === "state",
			);
			for (const authority of ["user_choice", "host_event"] as const) {
				const operations = stateEffects
					.filter((effect) => effect.authority === authority)
					.map(
						(effect) =>
							({
								path: effect.path,
								op: effect.op,
								...(effect.value === undefined ? {} : { value: effect.value }),
							}) as CharacterStateOperation,
					);
				if (operations.length === 0) continue;
				if (!input.conversationId || !this.characterState)
					throw { kind: "conflict", reason: "roleplay_state_service_unavailable" };
				this.characterState.commitAuthoritative({
					companionId: input.character.id,
					conversationId: input.conversationId,
					definition: input.character.state,
					authority,
					sourceId: `${id}:${authority}`,
					operations,
					reason: `Deterministic roleplay event ${event.id}.`,
					transaction,
				});
			}
		});
		return this.project(input.character, input.conversationId);
	}

	resetUnlocks(companionId: string): void {
		this.db.delete(roleplayUnlocks).where(eq(roleplayUnlocks.companionId, companionId)).run();
	}

	private applyEffects(
		values: Record<string, RoleplayValue>,
		effects: RoleplayEffect[],
		character: CharacterPackage,
		activeConversationId?: string,
		eventConversationId?: string,
	): void {
		for (const effect of effects) {
			const variable =
				"variable" in effect
					? character.roleplay.variables.find((candidate) => candidate.id === effect.variable)
					: undefined;
			if (variable?.scope === "conversation" && activeConversationId !== eventConversationId)
				continue;
			if (effect.type === "set") values[effect.variable] = effect.value;
			if (effect.type === "increment") {
				const current = values[effect.variable];
				if (typeof current !== "number")
					throw new Error(`roleplay variable ${effect.variable} is not numeric`);
				values[effect.variable] = current + effect.by;
			}
		}
		for (const variable of character.roleplay.variables)
			if (!(variable.id in values)) values[variable.id] = variable.initial;
	}
}

function evaluateCondition(condition: RoleplayCondition, state: RoleplayProjection): boolean {
	if ("all" in condition) return condition.all.every((part) => evaluateCondition(part, state));
	if ("any" in condition) return condition.any.some((part) => evaluateCondition(part, state));
	if ("not" in condition) return !evaluateCondition(condition.not, state);
	if ("unlocked" in condition) return state.unlocked.includes(condition.unlocked);
	if ("state" in condition) {
		const value = state.state[condition.state];
		if ("equals" in condition) return Object.is(value, condition.equals);
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

function validInitialOverride(
	variable: CharacterPackage["roleplay"]["variables"][number],
	value: RoleplayValue,
): boolean {
	if (variable.type === "number") return typeof value === "number";
	if (variable.type === "boolean") return typeof value === "boolean";
	if (variable.type === "string") return typeof value === "string";
	return typeof value === "string" && variable.values?.includes(value) === true;
}
