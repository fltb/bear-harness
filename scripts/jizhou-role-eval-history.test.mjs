import assert from "node:assert/strict";
import test from "node:test";
import { entriesAfterLeaf } from "./jizhou-role-eval-history.mjs";

const entries = (first, last) =>
	Array.from({ length: last - first + 1 }, (_, offset) => {
		const id = first + offset;
		return { id: String(id), parentId: String(id - 1) };
	});

test("a rolling native window retains every new entry despite unchanged array length", async () => {
	const snapshot = { branch: { entries: entries(21, 70) } };
	const actual = await entriesAfterLeaf(snapshot, "50", () => {
		throw new Error("Current window already contains the boundary");
	});
	assert.deepEqual(actual, entries(51, 70));
});

test("a turn larger than the window is recovered through native history pages", async () => {
	const snapshot = { branch: { entries: entries(51, 60) } };
	const actual = await entriesAfterLeaf(snapshot, "30", async (beforeId) => ({
		entries: entries(Number(beforeId) - 10, Number(beforeId) - 1),
	}));
	assert.deepEqual(actual, entries(31, 60));
});

test("a missing boundary is an error rather than an empty successful turn", async () => {
	await assert.rejects(
		entriesAfterLeaf({ branch: { entries: entries(51, 60) } }, "30", async () => ({ entries: [] })),
		Error,
	);
});
