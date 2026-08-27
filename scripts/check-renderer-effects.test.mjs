import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRendererEffects } from "./check-renderer-effects.mjs";

test("rejects direct, aliased and namespace reactive effects outside DOM adapters", () => {
	for (const source of [
		'import { createEffect } from "solid-js"; createEffect(() => setState(1));',
		'import { createEffect as watch } from "solid-js"; watch(() => mutate());',
		'import * as Solid from "solid-js"; Solid.createComputed(() => setState(1));',
		'import * as Solid from "solid-js"; Solid["createRenderEffect"](() => setState(1));',
	])
		assert.ok(checkRendererEffects(source, "packages/companion-ui/src/Test.tsx").length);
});
test("allows derived values and explicit user actions, but not state writes in the DOM exception", () => {
	assert.deepEqual(
		checkRendererEffects(
			"const value = createMemo(() => query.data); const submit = () => mutation.mutate();",
			"packages/companion-ui/src/Test.tsx",
		),
		[],
	);
	assert.ok(
		checkRendererEffects(
			"createEffect(() => setState(1));",
			"packages/companion-ui/src/lib/dom-effects.ts",
		).length,
	);
});
