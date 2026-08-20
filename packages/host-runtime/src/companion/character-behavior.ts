/**
 * CharacterBehaviorService — the Host-side authority for UI state requested by
 * a Companion Pi session. Character packages declare valid scenes, visual
 * states, and fixed event reactions; this service validates and persists every
 * resulting mutation. Pi never receives direct database or Electron access.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus, HostEvent } from "../storage/event-bus.js";
import {
	branches,
	companionIdentity,
	companionPackages,
	conversations,
	sceneState,
} from "../storage/schema.js";
import type { CharacterLoader, CharacterPackage } from "./character-loader.js";
import type { RoleplayProjection, RoleplayService } from "./roleplay-service.js";
export type CompanionHostToolName =
	| "host_get_state"
	| "host_set_scene"
	| "host_set_expression"
	| "host_get_roleplay_state"
	| "host_trigger_roleplay_event"
	| "host_play_media"
	| "host_present_choices"
	| "host_search_conversation_history"
	| "host_search_canon"
	| "host_remember"
	| "host_propose_work";

export interface CompanionHostToolCall {
	conversationId: string;
	triggerMessageId?: string;
	tool: string;
	args: unknown;
}

export interface CompanionHostToolResult {
	ok: boolean;
	code?: string;
	message: string;
	state?: CharacterRuntimeState;
	data?: unknown;
}

export interface CharacterRuntimeState {
	characterId: string;
	sceneId: string;
	visualState: string;
	sceneIds: string[];
	visualStates: string[];
	scenes: Array<{ id: string; label: string; useWhen: string }>;
	expressions: Array<{ id: string; label: string; useWhen: string }>;
}

interface StoredSceneState {
	id: string;
	scene: string;
	stateJson: unknown;
}

/** Host-owned, allowlisted character UI controls. */
export class CharacterBehaviorService {
	private readonly unsubscribe: () => void;
	private readonly pendingRoleplayEvents = new Map<
		string,
		Array<{ eventId: string; dedupeKey: string }>
	>();
	private readonly modelSelectedExpression = new Set<string>();

	constructor(
		private readonly db: AppDatabase,
		private readonly eventBus: EventBus,
		private readonly characterLoader: CharacterLoader,
		private readonly roleplay: RoleplayService,
	) {
		this.unsubscribe = this.eventBus.subscribe((event) => this.applyEventReaction(event));
	}

	dispose(): void {
		this.unsubscribe();
	}

	triggerUserRoleplayEvent(input: {
		conversationId: string;
		eventId: string;
		dedupeKey: string;
	}): RoleplayProjection {
		const character = this.characterForConversation(input.conversationId);
		if (!character) throw { kind: "not_found", reason: "conversation_not_found" };
		const branch = this.db
			.select({ id: branches.id, label: branches.label })
			.from(branches)
			.where(and(eq(branches.conversationId, input.conversationId), eq(branches.adopted, 1)))
			.get();
		if (!branch) throw { kind: "not_found", reason: "conversation_not_found" };
		if (branch.label !== "main")
			throw { kind: "conflict", reason: "roleplay_event_branch_not_canonical" };
		const state = this.roleplay.trigger({
			character,
			eventId: input.eventId,
			conversationId: input.conversationId,
			branchId: branch.id,
			dedupeKey: input.dedupeKey,
		});
		const event = character.roleplay.events.find((candidate) => candidate.id === input.eventId);
		if (event) this.applyRoleplayPresentation(input.conversationId, event.effects);
		this.eventBus.publish("roleplay.state_changed", {
			conversationId: input.conversationId,
			eventId: input.eventId,
			state,
		});
		return state;
	}

	/** Execute a request from the Companion utility process. */
	invoke(call: CompanionHostToolCall): CompanionHostToolResult {
		switch (call.tool) {
			case "host_get_state":
				return this.getStateResult(call.conversationId);
			case "host_set_scene":
				return this.setScene(call.conversationId, stringArgument(call.args, "sceneId"));
			case "host_set_expression":
				return this.setExpression(
					call.conversationId,
					stringArgument(call.args, "visualState"),
					"pi_tool",
				);
			case "host_get_roleplay_state":
				return this.getRoleplayState(call.conversationId);
			case "host_trigger_roleplay_event":
				return this.queueRoleplayEvent(call.conversationId, stringArgument(call.args, "eventId"));
			case "host_play_media":
				return this.presentMedia(call.conversationId, stringArgument(call.args, "mediaId"));
			case "host_present_choices":
				return this.presentChoices(call.conversationId, stringArgument(call.args, "choiceSetId"));
			default:
				return {
					ok: false,
					code: "host_tool_not_allowed",
					message: `Host tool is not allowlisted: ${call.tool}`,
				};
		}
	}

	private applyEventReaction(event: HostEvent): void {
		const conversationId = conversationIdFrom(event.payload);
		if (!conversationId) return;
		if (event.kind === "message.user_sent") this.modelSelectedExpression.delete(conversationId);
		if (event.kind === "message.assistant_committed")
			this.commitQueuedRoleplayEvents(conversationId, event.payload);
		if (
			event.kind === "message.aborted" ||
			(event.kind === "message_end" && failedFrom(event.payload))
		)
			this.pendingRoleplayEvents.delete(conversationId);
		const character = this.characterForConversation(conversationId);
		if (!character) return;
		const reaction = character.host.event_reactions.find(
			(candidate) => candidate.event === event.kind,
		);
		if (!reaction) return;
		if (event.kind === "message_end" && this.modelSelectedExpression.has(conversationId)) return;
		this.setExpression(conversationId, reaction.visual_state, `event:${event.kind}`);
	}

	private getRoleplayState(conversationId: string): CompanionHostToolResult {
		const character = this.characterForConversation(conversationId);
		if (!character) return unavailableConversationResult(conversationId);
		return {
			ok: true,
			message: "Current roleplay state.",
			data: this.roleplay.project(character, conversationId),
		};
	}

	private queueRoleplayEvent(
		conversationId: string,
		eventId: string | undefined,
	): CompanionHostToolResult {
		const character = this.characterForConversation(conversationId);
		if (!character) return unavailableConversationResult(conversationId);
		const branch = this.db
			.select({ label: branches.label })
			.from(branches)
			.where(and(eq(branches.conversationId, conversationId), eq(branches.adopted, 1)))
			.get();
		if (!branch || branch.label !== "main") {
			return {
				ok: false,
				code: "roleplay_event_branch_not_canonical",
				message: "Roleplay events can only commit from the main conversation branch.",
			};
		}
		if (!eventId || !character.roleplay.events.some((event) => event.id === eventId))
			return {
				ok: false,
				code: "invalid_roleplay_event",
				message: "The event is not declared by this character package.",
			};
		const pending = this.pendingRoleplayEvents.get(conversationId) ?? [];
		if (!pending.some((entry) => entry.eventId === eventId))
			pending.push({ eventId, dedupeKey: `${conversationId}:${eventId}:${pending.length}` });
		this.pendingRoleplayEvents.set(conversationId, pending);
		return {
			ok: true,
			message: "Roleplay event accepted; effects will commit with the completed reply.",
		};
	}

	private commitQueuedRoleplayEvents(conversationId: string, payload: unknown): void {
		const pending = this.pendingRoleplayEvents.get(conversationId);
		if (!pending?.length) return;
		const character = this.characterForConversation(conversationId);
		const versionId = objectString(payload, "versionId");
		const branch = this.db
			.select({ id: branches.id })
			.from(branches)
			.where(and(eq(branches.conversationId, conversationId), eq(branches.adopted, 1)))
			.get();
		if (!character || !versionId || !branch) return;
		for (const entry of pending) {
			this.roleplay.trigger({
				character,
				eventId: entry.eventId,
				conversationId,
				branchId: branch.id,
				sourceMessageVersionId: versionId,
				dedupeKey: `${versionId}:${entry.eventId}`,
			});
			const event = character.roleplay.events.find((candidate) => candidate.id === entry.eventId);
			if (event) this.applyRoleplayPresentation(conversationId, event.effects);
		}
		this.pendingRoleplayEvents.delete(conversationId);
		this.eventBus.publish("roleplay.state_changed", {
			conversationId,
			state: this.roleplay.project(character, conversationId),
		});
	}

	private applyRoleplayPresentation(
		conversationId: string,
		effects: CharacterPackage["roleplay"]["events"][number]["effects"],
	): void {
		for (const effect of effects) {
			if (effect.type === "scene") this.setScene(conversationId, effect.scene);
			if (effect.type === "expression")
				this.setExpression(conversationId, effect.expression, "roleplay_event");
			if (effect.type === "media") this.presentMedia(conversationId, effect.media);
		}
	}

	private presentMedia(
		conversationId: string,
		mediaId: string | undefined,
	): CompanionHostToolResult {
		const character = this.characterForConversation(conversationId);
		if (!character) return unavailableConversationResult(conversationId);
		const media = character.roleplay.media.find((entry) => entry.id === mediaId);
		if (!media)
			return {
				ok: false,
				code: "invalid_roleplay_media",
				message: "The media is not declared by this character package.",
			};
		const gatedUnlock = character.roleplay.unlockables.find((entry) => entry.media === media.id);
		if (
			gatedUnlock &&
			!this.roleplay.project(character, conversationId).unlocked.includes(gatedUnlock.id)
		)
			return {
				ok: false,
				code: "roleplay_media_locked",
				message: "The requested media has not been unlocked.",
			};
		this.eventBus.publish("roleplay.media_presented", { conversationId, mediaId: media.id });
		return { ok: true, message: `Presenting media ${media.id}.` };
	}

	private presentChoices(
		conversationId: string,
		choiceSetId: string | undefined,
	): CompanionHostToolResult {
		const character = this.characterForConversation(conversationId);
		if (!character) return unavailableConversationResult(conversationId);
		const choices = character.roleplay.choice_sets.find((entry) => entry.id === choiceSetId);
		if (!choices)
			return {
				ok: false,
				code: "invalid_roleplay_choices",
				message: "The choice set is not declared by this character package.",
			};
		this.eventBus.publish("roleplay.choices_presented", {
			conversationId,
			choiceSetId: choices.id,
		});
		return { ok: true, message: `Presenting choices ${choices.id}.` };
	}

	private getStateResult(conversationId: string): CompanionHostToolResult {
		const character = this.characterForConversation(conversationId);
		if (!character) return unavailableConversationResult(conversationId);
		return {
			ok: true,
			message: "Current character UI state.",
			state: this.currentState(conversationId, character),
		};
	}

	private setScene(conversationId: string, sceneId: string | undefined): CompanionHostToolResult {
		const character = this.characterForConversation(conversationId);
		if (!character) return unavailableConversationResult(conversationId);
		if (!sceneId || !character.scenes.some((scene) => scene.id === sceneId)) {
			return {
				ok: false,
				code: "invalid_scene",
				message: "The requested scene is not declared by this character package.",
				state: this.currentState(conversationId, character),
			};
		}

		const current = this.currentState(conversationId, character);
		const state = this.persistState(conversationId, sceneId, current.visualState);
		this.eventBus.publish("character.scene_changed", {
			conversationId,
			characterId: character.id,
			sceneId: state.sceneId,
			visualState: state.visualState,
			source: "pi_tool",
		});
		return { ok: true, message: `Scene changed to ${sceneId}.`, state };
	}

	private setExpression(
		conversationId: string,
		visualState: string | undefined,
		source: string,
	): CompanionHostToolResult {
		const character = this.characterForConversation(conversationId);
		if (!character) return unavailableConversationResult(conversationId);
		if (!visualState || !visualStateIds(character).includes(visualState)) {
			return {
				ok: false,
				code: "invalid_visual_state",
				message: "The requested expression is not declared by this character package.",
				state: this.currentState(conversationId, character),
			};
		}

		const current = this.currentState(conversationId, character);
		const state = this.persistState(conversationId, current.sceneId, visualState);
		if (source === "pi_tool" || source === "roleplay_event")
			this.modelSelectedExpression.add(conversationId);
		this.eventBus.publish("character.visual_state_changed", {
			conversationId,
			characterId: character.id,
			sceneId: state.sceneId,
			visualState: state.visualState,
			source,
		});
		return { ok: true, message: `Expression changed to ${visualState}.`, state };
	}

	private currentState(conversationId: string, character: CharacterPackage): CharacterRuntimeState {
		const stored = this.db
			.select({ id: sceneState.id, scene: sceneState.scene, stateJson: sceneState.stateJson })
			.from(sceneState)
			.where(eq(sceneState.conversationId, conversationId))
			.orderBy(desc(sceneState.updatedAt))
			.limit(1)
			.get() as StoredSceneState | undefined;
		const parsed = parseStoredState(stored?.stateJson);
		const sceneId = character.scenes.some((scene) => scene.id === stored?.scene)
			? (stored?.scene ?? character.visual.default_scene)
			: character.visual.default_scene;
		const allowedVisualStates = visualStateIds(character);
		const visualState =
			typeof parsed.visualState === "string" && allowedVisualStates.includes(parsed.visualState)
				? parsed.visualState
				: character.visual.default_expression;
		return {
			characterId: character.id,
			sceneId,
			visualState,
			sceneIds: character.scenes.map((scene) => scene.id),
			visualStates: allowedVisualStates,
			scenes: character.scenes.map((scene) => ({
				id: scene.id,
				label: scene.label,
				useWhen: scene.use_when,
			})),
			expressions: character.visual.expressions.map((expression) => ({
				id: expression.id,
				label: expression.label,
				useWhen: expression.use_when,
			})),
		};
	}

	private persistState(
		conversationId: string,
		sceneId: string,
		visualState: string,
	): CharacterRuntimeState {
		const character = this.characterForConversation(conversationId);
		if (!character) throw new Error(`conversation not found: ${conversationId}`);
		const existing = this.db
			.select({ id: sceneState.id })
			.from(sceneState)
			.where(eq(sceneState.conversationId, conversationId))
			.orderBy(desc(sceneState.updatedAt))
			.limit(1)
			.get();
		const stateJson = { visualState };
		if (existing) {
			this.db
				.update(sceneState)
				.set({ scene: sceneId, stateJson, updatedAt: sql`datetime('now')` })
				.where(eq(sceneState.id, existing.id))
				.run();
		} else {
			this.db
				.insert(sceneState)
				.values({ id: randomUUID(), conversationId, scene: sceneId, stateJson })
				.run();
		}
		return this.currentState(conversationId, character);
	}

	private characterForConversation(conversationId: string): CharacterPackage | null {
		const row = this.db
			.select({ packageId: companionPackages.id })
			.from(conversations)
			.innerJoin(companionIdentity, eq(companionIdentity.id, conversations.companionId))
			.innerJoin(companionPackages, eq(companionPackages.id, companionIdentity.packageId))
			.where(eq(conversations.id, conversationId))
			.get();
		return row ? this.characterLoader.load(row.packageId) : null;
	}
}

function visualStateIds(character: CharacterPackage): string[] {
	return character.visual.expressions.map((expression) => expression.id);
}

function stringArgument(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = (value as Record<string, unknown>)[key];
	return typeof candidate === "string" && candidate.length <= 64 ? candidate : undefined;
}

function conversationIdFrom(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const value = (payload as Record<string, unknown>).conversationId;
	return typeof value === "string" ? value : undefined;
}

function parseStoredState(value: unknown): Record<string, unknown> {
	if (!value) return {};
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error("persisted character state must be an object");
	}
	return value as Record<string, unknown>;
}

function objectString(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = (value as Record<string, unknown>)[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function failedFrom(value: unknown): boolean {
	return Boolean(
		value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			(value as Record<string, unknown>).failed,
	);
}

function unavailableConversationResult(conversationId: string): CompanionHostToolResult {
	return {
		ok: false,
		code: "conversation_not_found",
		message: `No character package is available for conversation ${conversationId}.`,
	};
}
