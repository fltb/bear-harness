// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jsonPatch from "fast-json-patch";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { RoleplayService } from "../src/companion/roleplay-service.js";
import { CharacterStateService } from "../src/companion/state-service.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";
import { conversations } from "../src/storage/schema.js";

const { getValueByPointer } = jsonPatch;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storyFixture() {
	const root = mkdtempSync(join(tmpdir(), "bear-undelivered-report-"));
	roots.push(root);
	const database = new Database(root);
	database.migrate(MIGRATIONS);
	const loader = new CharacterLoader(resolve(import.meta.dirname, "../../../config/characters"));
	const character = loader.load("jizhou");
	if (!character) throw new Error("missing jizhou character package");
	loader.seed(database.orm, new EventBus(database.orm), character);
	const state = new CharacterStateService(database.orm);
	const roleplay = new RoleplayService(database.orm, state);
	return { database, character, state, roleplay };
}

const routeCases = [
	{ id: "relay", events: ["story_route_relay"], expected: "relay" },
	{ id: "snowfield", events: ["story_route_snowfield"], expected: "snowfield" },
	{
		id: "relay-snowfield",
		events: ["story_route_relay", "story_route_snowfield_after_relay"],
		expected: "both",
	},
	{
		id: "snowfield-relay",
		events: ["story_route_snowfield", "story_route_relay_after_snowfield"],
		expected: "both",
	},
] as const;
const stanceCases = [
	{ id: "unresolved", event: "story_compare_unresolved", expected: "unresolved" },
	{ id: "cenlan", event: "story_compare_cenlan", expected: "cenlan" },
	{ id: "wenxi", event: "story_compare_wenxi", expected: "wenxi" },
] as const;
const futureCases = [
	{ id: "system", event: "story_future_design", expected: "resilient_queue" },
	{ id: "audit", event: "story_future_audit", expected: "audit_only" },
	{ id: "none", event: "story_future_no_system", expected: "no_system" },
	{ id: "refused", event: "story_future_refused", expected: "refused" },
] as const;
const endingCases = [
	{ id: "returned", event: "story_resolve_returned", expected: "returned" },
	{ id: "archived", event: "story_resolve_archived", expected: "archived" },
	{ id: "left-open", event: "story_resolve_left_open", expected: "left_open" },
] as const;

function requiredCase<T>(values: readonly T[], index: number): T {
	const value = values[index % values.length];
	if (!value) throw new Error("path coverage case is missing");
	return value;
}

function pick(document: object, pointers: readonly string[]): Record<string, unknown> {
	return Object.fromEntries(
		pointers.map((pointer) => [pointer, getValueByPointer(document, pointer)]),
	);
}

describe("《未送达的回报》complete path coverage", () => {
	it("completes 24 isolated paths without leaking state, facts, or affinity", () => {
		const { database, character, state, roleplay } = storyFixture();
		for (let index = 0; index < 24; index += 1) {
			const route = requiredCase(routeCases, index);
			const stance = requiredCase(stanceCases, index);
			const future = requiredCase(futureCases, index + Math.floor(index / 4));
			const ending = requiredCase(endingCases, index + Math.floor(index / 3));
			const conversationId = `story-path-${index + 1}`;
			database.orm
				.insert(conversations)
				.values({ id: conversationId, companionId: character.id })
				.run();
			let step = 0;
			const trigger = (eventId: string) =>
				roleplay.trigger({
					character,
					eventId,
					conversationId,
					dedupeKey: `${conversationId}:${step++}:${eventId}`,
				});

			for (const eventId of [
				"story_enter",
				"story_signal_examined",
				...route.events,
				stance.event,
				"story_last_shift",
				future.event,
				ending.event,
			])
				trigger(eventId);

			const values = state.project(character.id, conversationId, character.state).document;
			expect(
				pick(values, [
					"/story/undelivered_report/phase",
					"/story/undelivered_report/status",
					"/story/undelivered_report/route",
					"/story/undelivered_report/testimony_stance",
					"/story/undelivered_report/future_choice",
					"/story/undelivered_report/resolution",
					"/narrative/frame",
					"/narrative/location",
					"/narrative/time_anchor",
					"/narrative/evidence_mode",
					"/narrative/active_story",
					"/relationship/affinity",
				]),
				`${conversationId}:${route.id}:${stance.id}:${future.id}:${ending.id}`,
			).toMatchObject({
				"/story/undelivered_report/phase": "resolved",
				"/story/undelivered_report/status": ending.expected === "archived" ? "paused" : "completed",
				"/story/undelivered_report/route": route.expected,
				"/story/undelivered_report/testimony_stance": stance.expected,
				"/story/undelivered_report/future_choice": future.expected,
				"/story/undelivered_report/resolution": ending.expected,
				"/narrative/frame": "present",
				"/narrative/location": "study_dawn",
				"/narrative/time_anchor": "current_shift",
				"/narrative/evidence_mode": "direct_record",
				"/narrative/active_story": "none",
				"/relationship/affinity": 0,
			});
			expect(getValueByPointer(values, "/story/undelivered_report/known_facts")).toEqual([
				"旧站保存着一条未归入正确目录的损坏回报。",
				"岑岚与闻汐的记录存在数分钟时间差，不能据此确认任何一方撒谎。",
				"关站前的清点记录确认回报被错误归档，但最终接收方仍未知。",
			]);
		}
		database.close();
	});

	it("lets an archived ending reopen without replaying the story or losing facts", () => {
		const { database, character, state, roleplay } = storyFixture();
		const conversationId = "archived-reopen";
		database.orm
			.insert(conversations)
			.values({ id: conversationId, companionId: character.id })
			.run();
		let step = 0;
		const trigger = (eventId: string) =>
			roleplay.trigger({
				character,
				eventId,
				conversationId,
				dedupeKey: `${conversationId}:${step++}:${eventId}`,
			});
		for (const eventId of [
			"story_enter",
			"story_signal_examined",
			"story_route_snowfield",
			"story_compare_unresolved",
			"story_last_shift",
			"story_future_refused",
			"story_resolve_archived",
		])
			trigger(eventId);
		const archivedFacts = getValueByPointer(
			state.project(character.id, conversationId, character.state).document,
			"/story/undelivered_report/known_facts",
		);
		trigger("story_resume_archived");
		expect(
			pick(state.project(character.id, conversationId, character.state).document, [
				"/story/undelivered_report/phase",
				"/story/undelivered_report/status",
				"/story/undelivered_report/resolution",
				"/narrative/active_story",
				"/narrative/frame",
			]),
		).toMatchObject({
			"/story/undelivered_report/phase": "resolved",
			"/story/undelivered_report/status": "active",
			"/story/undelivered_report/resolution": "archived",
			"/narrative/active_story": "undelivered_report",
			"/narrative/frame": "present",
		});
		trigger("story_resolve_left_open");
		expect(
			pick(state.project(character.id, conversationId, character.state).document, [
				"/story/undelivered_report/phase",
				"/story/undelivered_report/status",
				"/story/undelivered_report/resolution",
				"/story/undelivered_report/known_facts",
				"/narrative/active_story",
			]),
		).toMatchObject({
			"/story/undelivered_report/phase": "resolved",
			"/story/undelivered_report/status": "completed",
			"/story/undelivered_report/resolution": "left_open",
			"/story/undelivered_report/known_facts": archivedFacts,
			"/narrative/active_story": "none",
		});
		database.close();
	});

	it("preserves the exact resume point across a pause and service restart at every chapter", () => {
		const { database, character, state, roleplay } = storyFixture();
		const conversationId = "pause-every-chapter";
		database.orm
			.insert(conversations)
			.values({ id: conversationId, companionId: character.id })
			.run();
		let eventIndex = 0;
		const trigger = (eventId: string) =>
			roleplay.trigger({
				character,
				eventId,
				conversationId,
				dedupeKey: `${conversationId}:event:${eventIndex++}:${eventId}`,
			});
		const chapters = [
			"story_enter",
			"story_signal_examined",
			"story_route_relay",
			"story_compare_unresolved",
			"story_last_shift",
			"story_future_design",
		] as const;

		for (const [index, eventId] of chapters.entries()) {
			trigger(eventId);
			const before = state.project(character.id, conversationId, character.state).document;
			const preserved = {
				phase: getValueByPointer(before, "/story/undelivered_report/phase"),
				position: getValueByPointer(before, "/story/undelivered_report/position"),
				route: getValueByPointer(before, "/story/undelivered_report/route"),
				frame: getValueByPointer(before, "/narrative/frame"),
				location: getValueByPointer(before, "/narrative/location"),
				timeAnchor: getValueByPointer(before, "/narrative/time_anchor"),
				evidenceMode: getValueByPointer(before, "/narrative/evidence_mode"),
				branch: getValueByPointer(before, "/narrative/branch"),
			};
			const turnId = `pause-${index}`;
			state.stage({
				companionId: character.id,
				conversationId,
				piSessionId: "session",
				sourceUserEntryId: turnId,
				definition: character.state,
				operations: [
					{ path: "/story/undelivered_report/status", op: "replace", value: "paused" },
					{ path: "/narrative/active_story", op: "replace", value: "none" },
					{ path: "/narrative/frame", op: "replace", value: "present" },
					{ path: "/narrative/location", op: "replace", value: "quiet_terminal" },
					{ path: "/narrative/time_anchor", op: "replace", value: "current_shift" },
					{ path: "/narrative/evidence_mode", op: "replace", value: "direct_record" },
				],
				reason: "The user paused the active story for a real task.",
				skillId: "undelivered-report",
				evidence: { source: "current_user", quote: "先停一下。" },
			});
			state.commitTurn({
				companionId: character.id,
				conversationId,
				piSessionId: "session",
				sourceUserEntryId: turnId,
				assistantEntryId: `${turnId}:assistant`,
				definition: character.state,
			});

			const reopened = new CharacterStateService(database.orm);
			const paused = reopened.project(character.id, conversationId, character.state).document;
			expect(
				pick(paused, [
					"/story/undelivered_report/status",
					"/story/undelivered_report/phase",
					"/story/undelivered_report/position",
					"/story/undelivered_report/route",
					"/narrative/active_story",
					"/narrative/frame",
				]),
			).toMatchObject({
				"/story/undelivered_report/status": "paused",
				"/story/undelivered_report/phase": preserved.phase,
				"/story/undelivered_report/position": preserved.position,
				"/story/undelivered_report/route": preserved.route,
				"/narrative/active_story": "none",
				"/narrative/frame": "present",
			});

			const resumeId = `resume-${index}`;
			reopened.stage({
				companionId: character.id,
				conversationId,
				piSessionId: "session",
				sourceUserEntryId: resumeId,
				definition: character.state,
				operations: [
					{ path: "/story/undelivered_report/status", op: "replace", value: "active" },
					{ path: "/narrative/active_story", op: "replace", value: "undelivered_report" },
					{ path: "/narrative/frame", op: "replace", value: preserved.frame },
					{ path: "/narrative/location", op: "replace", value: preserved.location },
					{ path: "/narrative/time_anchor", op: "replace", value: preserved.timeAnchor },
					{ path: "/narrative/evidence_mode", op: "replace", value: preserved.evidenceMode },
					{ path: "/narrative/branch", op: "replace", value: preserved.branch },
				],
				reason: "The user explicitly resumed from the saved story position.",
				skillId: "undelivered-report",
				evidence: { source: "current_user", quote: "继续刚才的剧情。" },
			});
			reopened.commitTurn({
				companionId: character.id,
				conversationId,
				piSessionId: "session",
				sourceUserEntryId: resumeId,
				assistantEntryId: `${resumeId}:assistant`,
				definition: character.state,
			});
			const resumed = reopened.project(character.id, conversationId, character.state).document;
			expect(
				pick(resumed, [
					"/story/undelivered_report/status",
					"/story/undelivered_report/phase",
					"/story/undelivered_report/position",
					"/narrative/active_story",
					"/narrative/frame",
					"/narrative/location",
					"/narrative/time_anchor",
					"/narrative/evidence_mode",
				]),
			).toMatchObject({
				"/story/undelivered_report/status": "active",
				"/story/undelivered_report/phase": preserved.phase,
				"/story/undelivered_report/position": preserved.position,
				"/narrative/active_story": "undelivered_report",
				"/narrative/frame": preserved.frame,
				"/narrative/location": preserved.location,
				"/narrative/time_anchor": preserved.timeAnchor,
				"/narrative/evidence_mode": preserved.evidenceMode,
			});
		}
		database.close();
	});
});
