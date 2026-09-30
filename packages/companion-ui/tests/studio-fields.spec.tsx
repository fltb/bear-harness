import { zhCN } from "@bear-harness/i18n/locales";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { parse } from "yaml";
import { ManifestFields } from "../src/features/studio/ManifestFields.js";

it("edits identity and global prompt independently while preserving examples and unknown sections", () => {
	const [source, setSource] = createSignal(
		"# author comment\nbehavior:\n  identity:\n    summary: Original identity\n  examples:\n    - user: Hello\n      assistant: Hi\nsystem_prompt: Original prompt\nmedia: []\n",
	);
	render(() => <ManifestFields source={source()} onChange={setSource} />);
	fireEvent.input(screen.getByLabelText(`${zhCN.studio.identity} ${zhCN.studio.required}`), {
		target: { value: "Updated identity" },
	});
	fireEvent.input(screen.getByLabelText(`${zhCN.studio.systemPrompt} ${zhCN.studio.optional}`), {
		target: { value: "Independent prompt" },
	});
	expect(parse(source())).toEqual({
		behavior: {
			identity: { summary: "Updated identity" },
			examples: [{ user: "Hello", assistant: "Hi" }],
		},
		system_prompt: "Independent prompt",
		media: [],
	});
	expect(source()).toContain("# author comment");
});
it("does not rewrite invalid YAML through an empty form", () => {
	const change = vi.fn();
	render(() => <ManifestFields source="behavior: [invalid" onChange={change} />);
	expect(screen.getByRole("alert")).toHaveTextContent(zhCN.studio.invalidYaml);
	expect(screen.queryAllByRole("textbox")).toHaveLength(0);
	expect(change).not.toHaveBeenCalled();
});

it("routes structurally invalid parent fields to raw editing without erasing them", () => {
	const change = vi.fn();
	render(() => (
		<ManifestFields source="behavior: a string instead of a mapping" onChange={change} />
	));
	expect(screen.getByRole("alert")).toHaveTextContent(zhCN.studio.invalidYaml);
	expect(screen.queryAllByRole("textbox")).toHaveLength(0);
	expect(change).not.toHaveBeenCalled();
});
