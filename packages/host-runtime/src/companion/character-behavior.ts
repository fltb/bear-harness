/**
 * CharacterBehaviorService — the Host-side authority for UI state requested by
 * a Companion Pi session. Character packages declare valid scenes, visual
 * states, and trusted Host event-to-visual-state reactions; this service
 * validates and persists every resulting mutation. Pi never receives direct
 * database or Electron access.
 */

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Diagnostics } from "../diagnostics/index.js";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus, HostEvent } from "../storage/event-bus.js";
import {
	companionIdentity,
	companionPackages,
	conversations,
	events,
	sceneState,
} from "../storage/schema.js";
import type { CharacterLoader, CharacterPackage } from "./character-loader.js";
import type { RoleplayProjection, RoleplayService } from "./roleplay-service.js";
import type { CharacterStateService } from "./state-service.js";
export type CompanionHostToolName =
	| "host_state"
	| "host_visual"
	| "host_present"
	| "host_history"
	| "host_canon"
	| "host_memory"
	| "host_attachment"
	| "host_delegate";

export interface CompanionHostToolCall {
	conversationId: string;
	triggerEntryId?: string;
	piSessionId?: string;
	toolCallId?: string;
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

/**
 * Minimal durable Pi branch projection consumed by turn lifecycle reactions.
 * The supervisor's live PiSessionHandle satisfies this shape; tests supply a
 * lightweight stand-in with the same entry list contract.
 */
export interface PiTurnBranchProjection {
	readonly sessionId: string;
	readonly sessionManager: { buildContextEntries(): unknown[] };
}

type ProjectedTurnEntry = {
	id: string;
	role: "user" | "assistant";
	stopReason?: string;
};

function projectTurnEntries(
	sessionManager: PiTurnBranchProjection["sessionManager"],
): ProjectedTurnEntry[] {
	const entries: ProjectedTurnEntry[] = [];
	for (const raw of sessionManager.buildContextEntries()) {
		if (!isRecord(raw) || raw.type !== "message" || typeof raw.id !== "string") continue;
		const message = raw.message;
		if (!isRecord(message) || typeof message.role !== "string") continue;
		if (message.role !== "user" && message.role !== "assistant") continue;
		// A native Pi turn may contain several assistant tool-use messages before
		// the terminal assistant response. Tool-use entries are not turn ends:
		// settling here would strand state and presentation effects staged later
		// in the same model/tool loop.
		if (message.role === "assistant" && message.stopReason === "toolUse") continue;
		entries.push({
			id: raw.id,
			role: message.role,
			...(typeof message.stopReason === "string"
				? { stopReason: message.stopReason as string }
				: {}),
		});
	}
	return entries;
}

/** Host-owned, allowlisted character UI controls. */
export class CharacterBehaviorService {
	private readonly unsubscribe: () => void;
	private readonly modelSelectedExpression = new Set<string>();
	private readonly seenTurnEntries = new Map<
		string,
		{ userEntryId?: string; assistantEntryId?: string }
	>();

	constructor(
		private readonly db: AppDatabase,
		private readonly eventBus: EventBus,
		private readonly characterLoader: CharacterLoader,
		private readonly roleplay: RoleplayService,
		private readonly characterState: CharacterStateService,
		private readonly piProjection?: (conversationId: string) => PiTurnBranchProjection | undefined,
		private readonly diagnostics?: Diagnostics,
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
		const projection = this.piProjection?.(input.conversationId);
		const state = this.roleplay.trigger({
			character,
			eventId: input.eventId,
			conversationId: input.conversationId,
			...(projection ? { piSessionId: projection.sessionId } : {}),
			dedupeKey: input.dedupeKey,
		});
		this.diagnostics?.emit("roleplay.state.transition", {
			conversationId: input.conversationId,
			eventId: input.eventId,
			phase: "committed",
		});
		this.eventBus.publish("roleplay.choices_dismissed", { conversationId: input.conversationId });
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
		const target = hostToolTarget(call.args);
		const span = this.diagnostics?.startSpan("host.rule.evaluate", {
			conversationId: call.conversationId,
			tool: call.tool,
			...(target ? { target } : {}),
		});
		const result =
			span && this.diagnostics
				? this.diagnostics.runInSpan(span, () => this.invokeAllowed(call))
				: this.invokeAllowed(call);
		span?.end(result.ok ? "ok" : "error", {
			decision: result.ok ? "allowed" : "rejected",
			...(result.code ? { resultCode: result.code } : {}),
		});
		return result;
	}

	private invokeAllowed(call: CompanionHostToolCall): CompanionHostToolResult {
		switch (call.tool) {
			case "host_visual": {
				const action = stringArgument(call.args, "action");
				if (action === "read") return this.getStateResult(call.conversationId);
				if (action === "update")
					return this.updateVisual(
						call.conversationId,
						stringArgument(call.args, "sceneId"),
						stringArgument(call.args, "expressionId"),
						"pi_tool",
						call,
					);
				break;
			}
			case "host_present": {
				const action = stringArgument(call.args, "action");
				if (action === "read_eligible")
					return this.readEligiblePresentations(call.conversationId, call);
				if (action === "present_media")
					return this.presentMedia(call.conversationId, stringArgument(call.args, "mediaId"), call);
				if (action === "present_choices")
					return this.presentChoices(
						call.conversationId,
						stringArgument(call.args, "choiceSetId"),
						call,
					);
				if (action === "dismiss")
					return this.dismissPresentation(
						call.conversationId,
						stringArgument(call.args, "presentationId"),
					);
				break;
			}
			default:
				break;
		}
		return {
			ok: false,
			code: "host_tool_not_allowed",
			message: `Host tool or action is not allowlisted: ${call.tool}`,
		};
	}

	private applyEventReaction(event: HostEvent): void {
		const conversationId = conversationIdFrom(event.payload);
		if (!conversationId) return;
		if (event.kind === "pi.session.changed") {
			this.applyPiSessionChanged(conversationId, event.payload);
			return;
		}
		const character = this.characterForConversation(conversationId);
		if (!character) return;
		const reaction = character.host.event_reactions.find(
			(candidate) => candidate.event === event.kind,
		);
		if (!reaction) return;
		const source = `event:${event.kind}`;
		this.setExpression(conversationId, reaction.visual_state, source);
	}

	/**
	 * Durable turn lifecycle now comes from Pi session notifications only.
	 * Roleplay commits and expression reactions are derived from native
	 * branch entries, never from Host transcript mirrors.
	 */
	private applyPiSessionChanged(conversationId: string, payload: unknown): void {
		if (!isRecord(payload) || payload.reason !== "message") return;
		const projection = this.piProjection?.(conversationId);
		if (!projection) return;
		const entries = projectTurnEntries(projection.sessionManager);
		const lastUser = findLast(entries, (entry) => entry.role === "user");
		const lastAssistant = findLast(entries, (entry) => entry.role === "assistant");
		const seen = this.seenTurnEntries.get(conversationId);
		const newUser = Boolean(lastUser && lastUser.id !== seen?.userEntryId);
		const newAssistant = Boolean(lastAssistant && lastAssistant.id !== seen?.assistantEntryId);
		this.seenTurnEntries.set(conversationId, {
			...(lastUser ? { userEntryId: lastUser.id } : {}),
			...(lastAssistant ? { assistantEntryId: lastAssistant.id } : {}),
		});
		if (!seen) {
			// A process may restart after a model tool staged state but before the
			// terminal Pi notification was observed. Reconcile that durable turn on
			// the first branch projection instead of silently stranding the mutation.
			if (lastUser && lastAssistant && entries.indexOf(lastAssistant) > entries.indexOf(lastUser))
				this.applyStateTurnEnd(conversationId, projection.sessionId, lastAssistant, lastUser.id);
			return;
		}
		if (newAssistant && lastAssistant) {
			this.applyTurnEnd(conversationId, projection.sessionId, lastAssistant, lastUser?.id);
			return;
		}
		if (newUser && lastUser) {
			this.modelSelectedExpression.delete(conversationId);
			this.applyReaction(conversationId, "message.user_sent");
		}
	}

	private applyTurnEnd(
		conversationId: string,
		sessionId: string,
		entry: ProjectedTurnEntry,
		userEntryId?: string,
	): void {
		if (userEntryId) this.applyStateTurnEnd(conversationId, sessionId, entry, userEntryId);
		if (entry.stopReason === "aborted") {
			this.modelSelectedExpression.delete(conversationId);
			this.applyReaction(conversationId, "message.aborted");
			return;
		}
		if (entry.stopReason === "error") return;
		const consumed = this.modelSelectedExpression.delete(conversationId);
		if (!consumed) this.applyReaction(conversationId, "message_end");
	}

	private applyStateTurnEnd(
		conversationId: string,
		sessionId: string,
		entry: ProjectedTurnEntry,
		userEntryId: string,
	): void {
		if (
			entry.stopReason === "aborted" ||
			entry.stopReason === "error" ||
			this.turnEffectFailed(conversationId, sessionId, userEntryId)
		) {
			this.characterState.discardTurn(conversationId, sessionId, userEntryId);
			this.settleTurnEffects(conversationId, sessionId, userEntryId, entry.id, false);
			return;
		}
		const character = this.characterForConversation(conversationId);
		if (!character) return;
		const result = this.characterState.commitTurn({
			companionId: character.id,
			conversationId,
			piSessionId: sessionId,
			sourceUserEntryId: userEntryId,
			assistantEntryId: entry.id,
			definition: character.state,
		});
		if (result.committed)
			this.eventBus.publish("character.state_changed", {
				conversationId,
				revisions: result.state.revisions,
				schemaHash: result.state.schemaHash,
			});
		this.settleTurnEffects(conversationId, sessionId, userEntryId, entry.id, true);
	}

	private turnEffectFailed(
		conversationId: string,
		piSessionId: string,
		sourceUserEntryId: string,
	): boolean {
		return Boolean(
			this.db
				.select({ seq: events.seq })
				.from(events)
				.where(
					and(
						eq(events.kind, "companion.turn_effect_failed"),
						sql`json_extract(${events.payload}, '$.conversationId') = ${conversationId}`,
						sql`json_extract(${events.payload}, '$.piSessionId') = ${piSessionId}`,
						sql`json_extract(${events.payload}, '$.sourceUserEntryId') = ${sourceUserEntryId}`,
					),
				)
				.limit(1)
				.get(),
		);
	}

	private settleTurnEffects(
		conversationId: string,
		piSessionId: string,
		sourceUserEntryId: string,
		assistantEntryId: string,
		completed: boolean,
	): void {
		const settled = this.db
			.select({ seq: events.seq })
			.from(events)
			.where(
				and(
					eq(events.kind, "companion.turn_effects_settled"),
					sql`json_extract(${events.payload}, '$.conversationId') = ${conversationId}`,
					sql`json_extract(${events.payload}, '$.piSessionId') = ${piSessionId}`,
					sql`json_extract(${events.payload}, '$.sourceUserEntryId') = ${sourceUserEntryId}`,
				),
			)
			.limit(1)
			.get();
		if (settled) return;
		const staged = this.db
			.select({ seq: events.seq, payload: events.payload })
			.from(events)
			.where(
				and(
					eq(events.kind, "companion.effect_staged"),
					sql`json_extract(${events.payload}, '$.conversationId') = ${conversationId}`,
					sql`json_extract(${events.payload}, '$.piSessionId') = ${piSessionId}`,
					sql`json_extract(${events.payload}, '$.sourceUserEntryId') = ${sourceUserEntryId}`,
				),
			)
			.orderBy(asc(events.seq))
			.all();
		if (completed) {
			for (const row of staged) {
				if (!isRecord(row.payload)) continue;
				const kind = row.payload.kind;
				const presentationId = row.payload.presentationId;
				if (typeof presentationId !== "string") continue;
				if (kind === "media")
					this.eventBus.publish("roleplay.media_presented", {
						conversationId,
						mediaId: presentationId,
					});
				if (kind === "choices")
					this.eventBus.publish("roleplay.choices_presented", {
						conversationId,
						choiceSetId: presentationId,
					});
			}
		} else {
			const firstVisual = staged.find(
				(row) => isRecord(row.payload) && row.payload.kind === "visual",
			)?.payload;
			if (
				isRecord(firstVisual) &&
				typeof firstVisual.beforeSceneId === "string" &&
				typeof firstVisual.beforeExpressionId === "string"
			) {
				const before = this.currentState(
					conversationId,
					this.characterForConversation(conversationId)!,
				);
				const rolledBack = this.persistState(
					conversationId,
					firstVisual.beforeSceneId,
					firstVisual.beforeExpressionId,
				);
				if (before.sceneId !== rolledBack.sceneId)
					this.eventBus.publish("character.scene_changed", {
						conversationId,
						characterId: rolledBack.characterId,
						sceneId: rolledBack.sceneId,
						visualState: rolledBack.visualState,
						source: "turn_rollback",
					});
				if (before.visualState !== rolledBack.visualState)
					this.eventBus.publish("character.visual_state_changed", {
						conversationId,
						characterId: rolledBack.characterId,
						sceneId: rolledBack.sceneId,
						visualState: rolledBack.visualState,
						source: "turn_rollback",
					});
			}
		}
		this.eventBus.publish("companion.turn_effects_settled", {
			conversationId,
			piSessionId,
			sourceUserEntryId,
			assistantEntryId,
			status: completed ? "committed" : "discarded",
		});
	}

	private applyReaction(conversationId: string, eventKind: string): void {
		const character = this.characterForConversation(conversationId);
		if (!character) return;
		const reaction = character.host.event_reactions.find(
			(candidate) => candidate.event === eventKind,
		);
		if (!reaction) return;
		this.setExpression(conversationId, reaction.visual_state, `event:${eventKind}`);
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
		provenance?: Pick<CompanionHostToolCall, "piSessionId" | "triggerEntryId" | "toolCallId">,
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
		const effectiveState = this.presentationGateState(conversationId, character, provenance);
		if (!this.roleplay.isEligible(character, conversationId, media.when, effectiveState))
			return {
				ok: false,
				code: "roleplay_media_locked",
				message: "The requested media is not eligible for the current story state.",
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
		const presentation = this.roleplay.presentation(character, conversationId);
		if (presentation.mediaId === media.id || presentation.ambientMediaId === media.id)
			return { ok: true, message: `Media ${media.id} is already presented.` };
		if (presentation.seenMediaIds.includes(media.id))
			return {
				ok: false,
				code: "roleplay_media_already_seen",
				message: "This story media was already shown and cannot be automatically presented again.",
			};
		if (hasTurnProvenance(provenance)) {
			if (this.isEffectStaged(conversationId, provenance, "media", media.id))
				return { ok: true, message: `Media ${media.id} is already staged for this response.` };
			this.stageEffect(conversationId, provenance, "media", media.id);
			return { ok: true, message: `Media ${media.id} staged for this response.` };
		}
		this.eventBus.publish("roleplay.media_presented", { conversationId, mediaId: media.id });
		return { ok: true, message: `Presenting media ${media.id}.` };
	}

	private readEligiblePresentations(
		conversationId: string,
		provenance?: Pick<CompanionHostToolCall, "piSessionId" | "triggerEntryId" | "toolCallId">,
	): CompanionHostToolResult {
		const character = this.characterForConversation(conversationId);
		if (!character) return unavailableConversationResult(conversationId);
		const unlocked = new Set(this.roleplay.project(character, conversationId).unlocked);
		const presentation = this.roleplay.presentation(character, conversationId);
		const effectiveState = this.presentationGateState(conversationId, character, provenance);
		return {
			ok: true,
			message: "Eligible role presentations read.",
			data: {
				media: character.roleplay.media
					.filter((media) => {
						if (!this.roleplay.isEligible(character, conversationId, media.when, effectiveState))
							return false;
						const gate = character.roleplay.unlockables.find((entry) => entry.media === media.id);
						return !gate || unlocked.has(gate.id);
					})
					.map((media) => ({
						id: media.id,
						label: media.label,
						presentation: media.presentation,
						seen: presentation.seenMediaIds.includes(media.id),
						presented:
							presentation.mediaId === media.id || presentation.ambientMediaId === media.id,
					})),
				choiceSets: character.roleplay.choice_sets
					.filter((set) =>
						this.roleplay.isEligible(character, conversationId, set.when, effectiveState),
					)
					.map((set) => ({
						id: set.id,
						prompt: set.prompt,
						presented: presentation.choiceSetId === set.id,
					})),
			},
		};
	}

	private dismissPresentation(
		conversationId: string,
		presentationId: string | undefined,
	): CompanionHostToolResult {
		const character = this.characterForConversation(conversationId);
		if (!character) return unavailableConversationResult(conversationId);
		const current = this.roleplay.presentation(character, conversationId);
		if (
			presentationId &&
			(current.mediaId === presentationId || current.ambientMediaId === presentationId)
		) {
			this.eventBus.publish("roleplay.media_dismissed", {
				conversationId,
				mediaId: presentationId,
			});
			return { ok: true, message: `Dismissed media ${presentationId}.` };
		}
		if (presentationId && current.choiceSetId === presentationId) {
			this.eventBus.publish("roleplay.choices_dismissed", { conversationId });
			return { ok: true, message: `Dismissed choices ${presentationId}.` };
		}
		return {
			ok: false,
			code: "presentation_not_active",
			message: "The requested presentation is not active.",
		};
	}

	private presentChoices(
		conversationId: string,
		choiceSetId: string | undefined,
		provenance?: Pick<CompanionHostToolCall, "piSessionId" | "triggerEntryId" | "toolCallId">,
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
		const effectiveState = this.presentationGateState(conversationId, character, provenance);
		if (!this.roleplay.isEligible(character, conversationId, choices.when, effectiveState))
			return {
				ok: false,
				code: "roleplay_choices_locked",
				message: "The requested choice set is not eligible for the current state.",
			};
		if (hasTurnProvenance(provenance)) {
			this.stageEffect(conversationId, provenance, "choices", choices.id);
			return { ok: true, message: `Choices ${choices.id} staged for this response.` };
		}
		this.eventBus.publish("roleplay.choices_presented", {
			conversationId,
			choiceSetId: choices.id,
		});
		return { ok: true, message: `Presenting choices ${choices.id}.` };
	}

	private presentationGateState(
		conversationId: string,
		character: CharacterPackage,
		provenance?: Pick<CompanionHostToolCall, "piSessionId" | "triggerEntryId" | "toolCallId">,
	): Record<string, unknown> | undefined {
		if (!hasTurnProvenance(provenance)) return undefined;
		return this.characterState.previewTurn({
			companionId: character.id,
			conversationId,
			piSessionId: provenance.piSessionId,
			sourceUserEntryId: provenance.triggerEntryId,
			definition: character.state,
		}).document;
	}

	private stageEffect(
		conversationId: string,
		provenance: Required<
			Pick<CompanionHostToolCall, "piSessionId" | "triggerEntryId" | "toolCallId">
		>,
		kind: "media" | "choices",
		presentationId: string,
	): void {
		this.eventBus.publish("companion.effect_staged", {
			conversationId,
			piSessionId: provenance.piSessionId,
			sourceUserEntryId: provenance.triggerEntryId,
			toolCallId: provenance.toolCallId,
			kind,
			presentationId,
		});
	}

	private isEffectStaged(
		conversationId: string,
		provenance: Required<
			Pick<CompanionHostToolCall, "piSessionId" | "triggerEntryId" | "toolCallId">
		>,
		kind: "media" | "choices",
		presentationId: string,
	): boolean {
		return Boolean(
			this.db
				.select({ seq: events.seq })
				.from(events)
				.where(
					and(
						eq(events.kind, "companion.effect_staged"),
						sql`json_extract(${events.payload}, '$.conversationId') = ${conversationId}`,
						sql`json_extract(${events.payload}, '$.piSessionId') = ${provenance.piSessionId}`,
						sql`json_extract(${events.payload}, '$.sourceUserEntryId') = ${provenance.triggerEntryId}`,
						sql`json_extract(${events.payload}, '$.kind') = ${kind}`,
						sql`json_extract(${events.payload}, '$.presentationId') = ${presentationId}`,
					),
				)
				.limit(1)
				.get(),
		);
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

	private setScene(
		conversationId: string,
		sceneId: string | undefined,
		source = "pi_tool",
	): CompanionHostToolResult {
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
		this.diagnostics?.emit("character.state.transition", {
			conversationId,
			state: "scene",
			from: current.sceneId,
			to: state.sceneId,
			source,
		});
		this.eventBus.publish("character.scene_changed", {
			conversationId,
			characterId: character.id,
			sceneId: state.sceneId,
			visualState: state.visualState,
			source,
		});
		return { ok: true, message: `Scene changed to ${sceneId}.`, state };
	}

	private updateVisual(
		conversationId: string,
		sceneId: string | undefined,
		expressionId: string | undefined,
		source: string,
		provenance?: Pick<CompanionHostToolCall, "piSessionId" | "triggerEntryId" | "toolCallId">,
	): CompanionHostToolResult {
		const character = this.characterForConversation(conversationId);
		if (!character) return unavailableConversationResult(conversationId);
		if (!sceneId && !expressionId)
			return {
				ok: false,
				code: "visual_update_empty",
				message: "A visual update requires a scene or expression.",
			};
		if (sceneId && !character.scenes.some((scene) => scene.id === sceneId))
			return { ok: false, code: "invalid_scene", message: "Scene is not declared." };
		if (expressionId && !visualStateIds(character).includes(expressionId))
			return {
				ok: false,
				code: "invalid_visual_state",
				message: "Expression is not declared.",
			};
		const before = this.currentState(conversationId, character);
		const nextScene = sceneId ?? before.sceneId;
		const nextExpression = expressionId ?? before.visualState;
		if (nextScene === before.sceneId && nextExpression === before.visualState)
			return { ok: true, message: "Visual state was already selected.", state: before };
		if (hasTurnProvenance(provenance))
			this.eventBus.publish("companion.effect_staged", {
				conversationId,
				piSessionId: provenance.piSessionId,
				sourceUserEntryId: provenance.triggerEntryId,
				toolCallId: provenance.toolCallId,
				kind: "visual",
				beforeSceneId: before.sceneId,
				beforeExpressionId: before.visualState,
				afterSceneId: nextScene,
				afterExpressionId: nextExpression,
			});
		const state = this.persistState(conversationId, nextScene, nextExpression);
		if (nextScene !== before.sceneId) {
			this.diagnostics?.emit("character.state.transition", {
				conversationId,
				state: "scene",
				from: before.sceneId,
				to: nextScene,
				source,
			});
			this.eventBus.publish("character.scene_changed", {
				conversationId,
				characterId: character.id,
				sceneId: nextScene,
				visualState: nextExpression,
				source,
			});
		}
		if (nextExpression !== before.visualState) {
			this.modelSelectedExpression.add(conversationId);
			this.diagnostics?.emit("character.state.transition", {
				conversationId,
				state: "expression",
				from: before.visualState,
				to: nextExpression,
				source,
			});
			this.eventBus.publish("character.visual_state_changed", {
				conversationId,
				characterId: character.id,
				sceneId: nextScene,
				visualState: nextExpression,
				source,
			});
		}
		return { ok: true, message: "Visual state updated.", state };
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
		this.diagnostics?.emit("character.state.transition", {
			conversationId,
			state: "expression",
			from: current.visualState,
			to: state.visualState,
			source,
		});
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

function hostToolTarget(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	for (const key of ["sceneId", "visualState", "eventId", "mediaId", "choiceSetId"]) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.length <= 128) return candidate;
	}
	return undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasTurnProvenance(
	value: Pick<CompanionHostToolCall, "piSessionId" | "triggerEntryId" | "toolCallId"> | undefined,
): value is Required<Pick<CompanionHostToolCall, "piSessionId" | "triggerEntryId" | "toolCallId">> {
	return Boolean(value?.piSessionId && value.triggerEntryId && value.toolCallId);
}

function findLast<T>(entries: readonly T[], predicate: (entry: T) => boolean): T | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry && predicate(entry)) return entry;
	}
	return undefined;
}

function unavailableConversationResult(conversationId: string): CompanionHostToolResult {
	return {
		ok: false,
		code: "conversation_not_found",
		message: `No character package is available for conversation ${conversationId}.`,
	};
}
