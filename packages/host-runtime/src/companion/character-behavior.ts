/**
 * CharacterBehaviorService — the Host-side authority for UI state requested by
 * a Companion Pi session. Character packages declare valid scenes, visual
 * states, and fixed event reactions; this service validates and persists every
 * resulting mutation. Pi never receives direct database or Electron access.
 */

import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus, HostEvent } from "../storage/event-bus.js";
import {
	companionIdentity,
	companionPackages,
	conversations,
	sceneState,
} from "../storage/schema.js";
import type { CharacterLoader, CharacterPackage } from "./character-loader.js";

export type CompanionHostToolName =
	| "host_get_state"
	| "host_set_scene"
	| "host_set_expression"
	| "host_propose_work";

export interface CompanionHostToolCall {
	conversationId: string;
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
}

interface StoredSceneState {
	id: string;
	scene: string;
	stateJson: unknown;
}

/** Host-owned, allowlisted character UI controls. */
export class CharacterBehaviorService {
	private readonly unsubscribe: () => void;

	constructor(
		private readonly db: AppDatabase,
		private readonly eventBus: EventBus,
		private readonly characterLoader: CharacterLoader,
	) {
		this.unsubscribe = this.eventBus.subscribe((event) => this.applyEventReaction(event));
	}

	dispose(): void {
		this.unsubscribe();
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
		const character = this.characterForConversation(conversationId);
		if (!character) return;
		const reaction = character.host.event_reactions.find(
			(candidate) => candidate.event === event.kind,
		);
		if (!reaction) return;
		this.setExpression(conversationId, reaction.visual_state, `event:${event.kind}`);
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
				: "presence";
		return {
			characterId: character.id,
			sceneId,
			visualState,
			sceneIds: character.scenes.map((scene) => scene.id),
			visualStates: allowedVisualStates,
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
	const declared = new Set(
		[...character.visual_states.required, ...character.visual_states.optional].map(
			(state) => state.id,
		),
	);
	return Object.keys(character.visual.presence).filter((state) => declared.has(state));
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

function unavailableConversationResult(conversationId: string): CompanionHostToolResult {
	return {
		ok: false,
		code: "conversation_not_found",
		message: `No character package is available for conversation ${conversationId}.`,
	};
}
