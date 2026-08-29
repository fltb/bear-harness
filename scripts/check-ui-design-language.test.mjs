import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

const checker = resolve(import.meta.dirname, "check-ui-design-language.mjs");

function fixture(overrides = {}) {
	const root = mkdtempSync(resolve(tmpdir(), "bear-ui-policy-"));
	const files = {
		"config/ui-design-system-policy.json": JSON.stringify({
			styleSheets: [
				"packages/companion-ui/src/styles.css",
				"packages/companion-ui/src/styles/base.css",
				"packages/companion-ui/src/styles/layout.css",
			],
			layoutStyleSheet: "packages/companion-ui/src/styles/layout.css",
			tokenStyleSheet: "packages/companion-ui/src/styles/base.css",
			headlessPrimitiveFacade: "packages/companion-ui/src/ui/primitives.ts",
			inlineStyleAllowlist: [],
		}),
		"packages/companion-ui/src/styles.css": '@import "./styles/base.css";\n',
		"packages/companion-ui/src/styles/base.css":
			"@theme { --color-ink: #111; }\n.control { @apply p-2; }\n",
		"packages/companion-ui/src/styles/layout.css": '.app[data-layout="mobile"] { @apply grid; }\n',
		"packages/companion-ui/src/ui/primitives.ts":
			'export { Button } from "@kobalte/core/button";\n',
		"packages/companion-ui/src/View.tsx": 'export const View = () => <div class="control" />;\n',
		...overrides,
	};
	for (const [name, content] of Object.entries(files)) {
		const file = resolve(root, name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
	return root;
}

function check(root) {
	try {
		execFileSync(process.execPath, [checker], {
			env: { ...process.env, BEAR_UI_POLICY_ROOT: root },
			stdio: "pipe",
		});
		return "";
	} catch (error) {
		return String(error.stderr);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("accepts the registered design-language path", () => {
	assert.equal(check(fixture()), "");
});

test("rejects a feature breakpoint", () => {
	const output = check(
		fixture({
			"packages/companion-ui/src/styles/base.css":
				"@theme { --color-ink: #111; }\n.control { @apply p-2; }\n@media (max-width: 10px) {}\n",
		}),
	);
	assert.match(output, /@media belongs in layout\.css/);
});

test("rejects an unregistered stylesheet", () => {
	const output = check(
		fixture({ "packages/companion-ui/src/styles/escape.css": ".escape { @apply fixed; }\n" }),
	);
	assert.match(output, /stylesheet is not registered/);
});

test("rejects unstyled classes and inline visual bypasses", () => {
	const output = check(
		fixture({
			"packages/companion-ui/src/View.tsx":
				'export const View = () => <div class="missing" style={{ color: "red" }} />;\n',
		}),
	);
	assert.match(output, /class 'missing' has no registered CSS selector/);
	assert.match(output, /inline style is not approved/);
});

test("rejects headless primitive imports outside the product UI facade", () => {
	const output = check(
		fixture({
			"packages/companion-ui/src/View.tsx":
				'import { Button } from "@kobalte/core/button";\nexport const View = () => <Button class="control" />;\n',
		}),
	);
	assert.match(output, /headless primitives must be imported through the product UI facade/);
});
