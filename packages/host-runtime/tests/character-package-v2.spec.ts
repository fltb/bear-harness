// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharacterDisplay } from "@bear-harness/protocol/schema";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { CompanionStateStore } from "../src/companion/companion-store.js";
import { FirstMeetingMachine } from "../src/companion/first-meeting.js";
import { CharacterStateSchema } from "../src/companion/state-schema.js";
import { COMPANION_SCHEMA_SQL, CompanionDatabase } from "../src/storage/database.js";
import { conversations, onboardingState } from "../src/storage/schema.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "bear-v2-"));
	roots.push(root);
	const directory = join(root, "test-role");
	mkdirSync(directory);
	const manifest = {
		format_version: 2,
		version: "1.0.0",
		id: "test-role",
		name: "Test role",
		language: "en-US",
		behavior: { identity: { summary: "An observatory keeper." } },
	};
	const path = join(directory, "character.yaml");
	writeFileSync(path, stringify(manifest));
	return { root, directory, path, manifest, loader: new CharacterLoader(root) };
}
function state(defaultValue: number, maximum = 100) {
	return CharacterStateSchema.parse({
		$schema: "https://json-schema.org/draft/2020-12/schema",
		type: "object",
		additionalProperties: false,
		properties: {
			affinity: {
				type: "number",
				"x-scope": "global",
				default: defaultValue,
				minimum: 0,
				maximum,
				title: "Affinity",
				description: "Relationship affinity.",
			},
		},
	});
}
describe("character package v2", () => {
	it("loads a one-file text role with no media, state or first meeting", () => {
		const { loader } = fixture();
		const character = loader.load("test-role");
		if (!character) throw new Error("missing role");
		expect(CharacterDisplay.parse(loader.display(character)).visual).toMatchObject({
			defaultSceneId: null,
			defaultExpressionId: null,
			expressions: {},
		});
		expect(character.canon.sources).toEqual([]);
		expect(character.character.first_meeting).toBeUndefined();
		expect(character.state.fields).toEqual({});
		expect(character.behavior).toEqual({ identity: { summary: "An observatory keeper." } });
	});
	it("invalidates cached documents when content changes and rejects symlinks", () => {
		const { loader, directory } = fixture();
		mkdirSync(join(directory, "canon"));
		const path = join(directory, "canon", "notes.md");
		writeFileSync(path, "# Notes\nFirst version.");
		expect(loader.load("test-role")?.canon.sources[0]?.content).toContain("First version");
		writeFileSync(path, "# Notes\nSecond version.");
		expect(loader.load("test-role")?.canon.sources[0]?.content).toContain("Second version");
		symlinkSync(path, join(directory, "canon", "alias.md"));
		expect(() => loader.load("test-role")).toThrow();
	});
	it("rejects old packages and Canon manifests instead of guessing a fallback", () => {
		const { loader, path, manifest, directory } = fixture();
		writeFileSync(path, stringify({ ...manifest, format_version: 1 }));
		expect(() => loader.load("test-role")).toThrow(/format_version/);
		writeFileSync(path, stringify(manifest));
		mkdirSync(join(directory, "canon"));
		writeFileSync(join(directory, "canon", "manifest.yaml"), "sources: []");
		expect(() => loader.load("test-role")).toThrow(/obsolete/);
	});
	it("persists no-flow onboarding once and retains completed answers", () => {
		const { loader, root } = fixture();
		const database = new CompanionDatabase(join(root, "runtime.db"), "test-role");
		try {
			database.initialize(COMPANION_SCHEMA_SQL);
			database.ensureRuntimeIdentity();
			const machine = new FirstMeetingMachine(database.orm, loader);
			expect(machine.getState("test-role").status).toBe("complete");
			expect(database.orm.select().from(onboardingState).all()).toEqual([]);
			machine.initialize("test-role");
			expect(database.orm.select().from(onboardingState).all()).toHaveLength(1);
			database.orm
				.update(onboardingState)
				.set({ stateJson: { answers: { old_choice: "retain" } } })
				.run();
			expect(machine.initialize("test-role")).toMatchObject({
				stateData: { answers: { old_choice: "retain" } },
			});
		} finally {
			database.close();
		}
	});
	it("accepts primitive scopes and preserves existing values on incompatible schema changes", () => {
		const { loader, root } = fixture();
		const base = loader.load("test-role");
		if (!base) throw new Error("missing role");
		const character = { ...base, state: state(0) };
		const database = new CompanionDatabase(join(root, "runtime.db"), "test-role");
		try {
			database.initialize(COMPANION_SCHEMA_SQL);
			database.ensureRuntimeIdentity();
			database.orm
				.insert(conversations)
				.values({ id: "conversation", companionId: character.id })
				.run();
			const store = new CompanionStateStore(database.orm);
			store.writeCompanion({
				companionId: character.id,
				conversationId: "conversation",
				character,
				definition: character.state,
				changes: [{ path: "/character/affinity", value: 60 }],
			});
			expect(() => store.reconcileSchema(character.id, state(0, 10))).toThrow(
				expect.objectContaining({ reason: "character_state_schema_incompatible" }),
			);
			expect(store.project(character.id, "conversation", character.state).document).toEqual({
				affinity: 60,
			});
			expect(store.snapshot(character, "conversation").display).toMatchObject({
				sceneId: null,
				expressionId: null,
			});
			expect(() => state(100, 10)).toThrow(/defaults/);
		} finally {
			database.close();
		}
	});
	it("refuses schema replacement before touching the installed package", () => {
		const { loader, path, manifest } = fixture();
		const original = readFileSync(path, "utf8");
		const current = loader.readPackageDocument("test-role");
		expect(() =>
			loader.writePackageDocument({
				characterId: "test-role",
				yaml: stringify({ ...manifest, state_schema: state(0) }),
				expectedSha256: current.sha256,
			}),
		).toThrow();
		expect(readFileSync(path, "utf8")).toBe(original);
	});
});
