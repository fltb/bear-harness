import assert from "node:assert/strict";
import test from "node:test";
import { appendBoundedTrace } from "./bounded-trace.ts";

test("deterministic provider traces retain only the newest bounded observations", () => {
	const trace = ["a", "b"];
	appendBoundedTrace(trace, "c", 2);
	assert.deepEqual(trace, ["b", "c"]);
});
