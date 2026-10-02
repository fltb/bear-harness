import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStudioWorkflow } from "../src/features/studio/workflow.js";
import type { CharacterDraft } from "../src/stores/ipc.js";
import type { CharacterApi } from "../src/stores/supplementary-api.js";

const disposals: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const draft: CharacterDraft = {
	id: "test~00000000-0000-4000-8000-000000000000",
	characterId: "test",
	status: "draft",
	locale: "en-US",
	currentRevision: 1,
	updatedAt: "2026-10-01T00:00:00.000Z",
	files: { "character.yaml": { encoding: "utf8", sha256: "a".repeat(64), size: 8 } },
};
function setup(patch: CharacterApi["draftPatch"]) {
	const api = {
		draftPatch: patch,
		draftFile: vi.fn(async () => new TextEncoder().encode("original")),
	} as unknown as CharacterApi;
	const workflow = createRoot((dispose) => {
		disposals.push(dispose);
		return createStudioWorkflow(api);
	});
	return { workflow, api };
}
describe("Studio draft editing", () => {
	it("saves typing received during an in-flight save as the next revision", async () => {
		const first = deferred<CharacterDraft>();
		const patch = vi
			.fn<CharacterApi["draftPatch"]>()
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce({ ...draft, currentRevision: 3 });
		const { workflow } = setup(patch);
		await workflow.open(draft);
		workflow.edit("character.yaml", "first edit");
		const saving = workflow.flush();
		workflow.edit("character.yaml", "later edit");
		first.resolve({ ...draft, currentRevision: 2 });
		await saving;
		expect(patch.mock.calls.map((call) => [call[1], call[2]])).toEqual([
			[1, { "character.yaml": { encoding: "utf8", content: "first edit" } }],
			[2, { "character.yaml": { encoding: "utf8", content: "later edit" } }],
		]);
		expect(workflow.texts()["character.yaml"]).toBe("later edit");
		expect(workflow.draft()?.currentRevision).toBe(3);
		expect(workflow.dirty()).toBe(false);
	});
	it("keeps newer input after a save conflict and blocks leaving until resolved", async () => {
		const first = deferred<CharacterDraft>();
		const patch = vi
			.fn<CharacterApi["draftPatch"]>()
			.mockReturnValueOnce(first.promise)
			.mockRejectedValue(new Error("character_draft_revision_mismatch"));
		const { workflow } = setup(patch);
		await workflow.open(draft);
		workflow.edit("character.yaml", "old edit");
		const saving = workflow.flush();
		workflow.edit("character.yaml", "new edit");
		const failure = expect(saving).rejects.toThrow("character_draft_revision_mismatch");
		first.reject(new Error("character_draft_revision_mismatch"));
		await failure;
		expect(workflow.texts()["character.yaml"]).toBe("new edit");
		expect(workflow.dirty()).toBe(true);
		await expect(workflow.open({ ...draft, id: "another" })).rejects.toThrow(
			"character_draft_revision_mismatch",
		);
		expect(workflow.draft()?.id).toBe(draft.id);
		expect(patch.mock.calls[1]?.[2]).toEqual({
			"character.yaml": { encoding: "utf8", content: "new edit" },
		});
	});
});

it("undoes and redoes whole saved revisions and starts a new branch after editing an undone draft", async () => {
	let revision = 1;
	const bodies = new Map<number, string>([[1, "original"]]);
	const { workflow, api } = setup(async (_id, expected, files) => {
		expect(expected).toBe(revision);
		revision++;
		bodies.set(revision, files["character.yaml"]?.content ?? "");
		return { ...draft, currentRevision: revision };
	});
	api.draftFile = async () => new TextEncoder().encode(bodies.get(revision));
	api.draftListRevisions = async () =>
		[...bodies.keys()].reverse().map((revision) => ({ revision, createdAt: draft.updatedAt }));
	api.draftRestoreRevision = async (_id, expected, source) => {
		expect(expected).toBe(revision);
		revision++;
		bodies.set(revision, bodies.get(source)!);
		return { ...draft, currentRevision: revision };
	};
	await workflow.open(draft);
	workflow.edit("character.yaml", "first edit");
	await workflow.flush();
	workflow.edit("character.yaml", "second edit");
	await workflow.flush();
	await workflow.undo();
	expect(workflow.texts()["character.yaml"]).toBe("first edit");
	expect(workflow.canRedo()).toBe(1);
	await workflow.undo(true);
	expect(workflow.texts()["character.yaml"]).toBe("second edit");
	await workflow.undo();
	workflow.edit("character.yaml", "new branch");
	await workflow.flush();
	expect(workflow.canRedo()).toBe(0);
	await workflow.undo();
	expect(workflow.texts()["character.yaml"]).toBe("first edit");
});

it("drops pruned undo and redo targets before restoring another revision", async () => {
	let revision = 3;
	const { workflow, api } = setup(async () => ({ ...draft, currentRevision: ++revision }));
	api.draftListRevisions = async () =>
		[3, 2, 1].map((revision) => ({ revision, createdAt: draft.updatedAt }));
	api.draftRestoreRevision = vi.fn(async () => ({ ...draft, currentRevision: ++revision }));
	await workflow.open({ ...draft, currentRevision: 3 });
	await workflow.undo();
	expect(workflow.canRedo()).toBe(1);
	workflow.retainHistory([4]);
	expect(workflow.canUndo()).toBe(0);
	expect(workflow.canRedo()).toBe(0);
	await workflow.undo();
	expect(api.draftRestoreRevision).toHaveBeenCalledTimes(1);
});
