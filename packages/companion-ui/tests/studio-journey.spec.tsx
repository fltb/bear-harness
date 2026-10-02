import { zhCN } from "@bear-harness/i18n/locales";
import type { CharacterDraft } from "@bear-harness/protocol";
import { z } from "@bear-harness/schema";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { CharacterManifestSchema } from "../../host-runtime/src/companion/character-loader.js";
import { RoleSkillMetadata } from "../../host-runtime/src/companion/role-resources.js";
import { CharacterStudio } from "../src/features/studio/CharacterStudio.js";
import { PackageForms, SkillFields } from "../src/features/studio/PackageForms.js";
import { type EditorSchema, SchemaFields } from "../src/features/studio/SchemaFields.js";
import type { CharacterApi } from "../src/stores/supplementary-api.js";
import { selectKobalteOption } from "./kobalte-helpers.js";

const fixture = vi.hoisted(() => ({
	store: {} as { characters: CharacterApi; model: { models: () => unknown[] } },
}));
vi.mock("../src/stores/companion.js", () => ({ useCompanionStore: () => fixture.store }));
const copy = zhCN.studio;
const schemas = {
	manifest: z.toJSONSchema(CharacterManifestSchema, { io: "input" }),
	skill: z.toJSONSchema(RoleSkillMetadata, { io: "input" }),
};
const manifest = {
	format_version: 2,
	id: "author-test",
	version: "1.0.0",
	name: "Author test",
	language: "zh-CN",
	behavior: {
		identity: { summary: "An editor fixture." },
		interaction: "Answer briefly.",
		examples: [{ user: "Hello", assistant: "Hi." }],
	},
	character: {
		subtitle: "Subtitle",
		greeting: "Greeting",
		composer_placeholder: "Message",
		first_meeting: {
			step_label: "Step",
			dialog_label: "Meeting",
			error_prefix: "Error",
			steps: [
				{
					id: "hello",
					kind: "acknowledge",
					heading: "Welcome",
					body: "Welcome body",
					submit_label: "Continue",
				},
				{
					id: "name",
					kind: "text",
					heading: "Name",
					body: "Name body",
					answer_key: "nickname",
					input_label: "Nickname",
					input_placeholder: "Name",
					min_length: 1,
					max_length: 20,
					submit_label: "Done",
				},
				{
					id: "choice",
					kind: "choice",
					heading: "Choose",
					body: "Choose body",
					answer_key: "drink",
					choices: [
						{ value: "tea", label: "Tea", description: "Warm" },
						{ value: "water", label: "Water", description: "Cold" },
					],
				},
			],
		},
	},
	scenes: [
		{
			id: "room",
			label: "Room",
			description: "Quiet",
			background: "assets/view.png",
			use_when: "At home",
			default: true,
		},
	],
	visual: {
		avatar: "assets/view.png",
		default_expression: "calm",
		expressions: [{ id: "calm", label: "Calm", asset: "assets/view.png", use_when: "At rest" }],
	},
	media: [
		{
			id: "photo",
			kind: "image",
			label: "Photo",
			description: "A photo",
			use_when: "When asked",
			asset: "assets/view.png",
			loop: false,
		},
	],
	state_schema: {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		type: "object",
		additionalProperties: false,
		properties: {
			mood: {
				type: "string",
				title: "Mood",
				description: "Current mood",
				default: "calm",
				"x-scope": "conversation",
			},
		},
	},
	system_prompt: "Role instruction",
};
const skill =
	"---\nname: read\ndescription: Read a document\ntriggers:\n  include: [Read]\n  exclude: [Other]\nallowed-tools: [host_choices]\npriority: 0\n---\nRead the supplied document.\n";
function setup() {
	let current: CharacterDraft;
	let bodies: Record<string, string> = {
		"character.yaml": stringify(manifest),
		"canon/note.md": "# Note\nReference.",
		"skills/read/SKILL.md": skill,
		"assets/view.png": "image",
	};
	const revisions = new Map<number, Record<string, string>>();
	let present = false;
	const make = (id = "author-test", name = "Author test") => {
		bodies = { ...bodies, "character.yaml": stringify({ ...manifest, id, name }) };
		current = {
			id: `${id}~00000000-0000-4000-8000-000000000000`,
			characterId: id,
			status: "draft",
			locale: "zh-CN",
			currentRevision: 1,
			updatedAt: "2026-10-02",
			files: {},
		};
		present = true;
		return save(false);
	};
	const save = (bump = true) => {
		if (bump) current = { ...current, currentRevision: current.currentRevision + 1 };
		current = {
			...current,
			files: Object.fromEntries(
				Object.entries(bodies).map(([path, body]) => [
					path,
					{
						encoding: path.endsWith(".png") ? "base64" : "utf8",
						sha256: "a".repeat(64),
						size: body.length,
					},
				]),
			),
		};
		revisions.set(current.currentRevision, { ...bodies });
		return current;
	};
	const api = {
		authoringSchema: vi.fn(async () => schemas),
		list: vi.fn(async () => ({
			characters: [{ id: "author-test", name: "Author test", subtitle: "Subtitle" }],
		})),
		draftListPage: vi.fn(async () => ({ drafts: present ? [current] : [] })),
		draftList: vi.fn(async () => (present ? [current] : [])),
		draftCreate: vi.fn(async (input) => make(input.characterId, input.name)),
		draftGet: vi.fn(async () => current),
		draftFile: vi.fn(async (_id, path) => new TextEncoder().encode(bodies[path] ?? "")),
		draftPatch: vi.fn(async (_id, revision, files) => {
			expect(revision).toBe(current.currentRevision);
			for (const [path, file] of Object.entries(files)) {
				if (file === null) delete bodies[path];
				else bodies[path] = file.content;
			}
			return save();
		}),
		draftListRevisions: vi.fn(async () =>
			[...revisions.keys()].reverse().map((revision) => ({ revision, createdAt: "2026-10-02" })),
		),
		draftRestoreRevision: vi.fn(async (_id, _expected, source) => {
			bodies = { ...revisions.get(source) };
			return save();
		}),
		draftValidate: vi.fn(async () => current),
		draftReview: vi.fn(async () => ({
			issues: [],
			changes: [{ path: "character.yaml", kind: "modified", binary: false }],
		})),
		draftDiff: vi.fn(async () => ({
			before: "Old content",
			after: bodies["character.yaml"],
			truncated: false,
		})),
		draftPublish: vi.fn(async () => ({ ...current, status: "published" })),
		draftExport: vi.fn(async () => new Uint8Array([80, 75])),
		draftManage: vi.fn(async (input) => {
			if (input.action === "delete") {
				present = false;
				return {};
			}
			if (input.action === "move") {
				bodies[input.to] = bodies[input.from]!;
				delete bodies[input.from];
				return { draft: save() };
			}
			return { draft: current };
		}),
		draftUploadFile: vi.fn(async (_id, _revision, path) => {
			bodies[path] = "Uploaded";
			return save();
		}),
		import: vi.fn(async () => undefined),
		select: vi.fn(async () => undefined),
	} as unknown as CharacterApi;
	fixture.store = { characters: api, model: { models: () => [] } };
	return { api, make, body: (path: string) => bodies[path] };
}
beforeEach(() => {
	vi.spyOn(window, "confirm").mockReturnValue(true);
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL() {
				return "blob:test";
			}
			static revokeObjectURL() {}
		},
	);
});
async function click(
	user: ReturnType<typeof userEvent.setup>,
	name: string | RegExp,
	root: HTMLElement = document.body,
) {
	const button = await within(root).findByRole("button", { name, exact: typeof name === "string" });
	await waitFor(() => expect(button).toBeEnabled());
	await user.click(button);
}

it("creates a complete draft, edits both representations, moves a document, restores history and reviews before applying", async () => {
	const { api, body } = setup();
	const user = userEvent.setup();
	const onClose = vi.fn();
	render(() => <CharacterStudio onClose={onClose} />);
	await screen.findByRole("heading", { name: "Author test" });
	await click(user, copy.newRole);
	const dialog = screen.getByRole("dialog");
	await user.type(within(dialog).getByLabelText(copy.name), "New author");
	await user.type(within(dialog).getByLabelText(copy.id), "new-author");
	await click(user, copy.create, dialog);
	const identity = await screen.findByRole("textbox", {
		name: `${copy.identity} ${copy.required}`,
	});
	fireEvent.input(identity, { target: { value: "Changed identity" } });
	await click(user, copy.save);
	await waitFor(() => expect(body("character.yaml")).toContain("Changed identity"));
	await click(user, `${copy.sections.scenes} · scenes`);
	const label = screen.getByRole("textbox", { name: /scenes\.0\.label/ });
	fireEvent.input(label, { target: { value: "Changed room" } });
	await click(user, copy.save);
	await click(user, "character.yaml");
	await screen.findByRole("textbox", { name: copy.source });
	expect(body("character.yaml")).toContain("Changed room");
	await click(user, copy.undo);
	await waitFor(() => expect(body("character.yaml")).not.toContain("Changed room"));
	await click(user, copy.redo);
	await waitFor(() => expect(body("character.yaml")).toContain("Changed room"));
	fireEvent.input(screen.getByLabelText(copy.filePath), { target: { value: "canon/new.md" } });
	await click(user, copy.newFile);
	fireEvent.input(await screen.findByRole("textbox", { name: copy.source }), {
		target: { value: "# New\nText" },
	});
	await click(user, copy.save);
	vi.spyOn(window, "prompt").mockReturnValue("canon/moved.md");
	await click(user, copy.moveFile);
	await screen.findByRole("heading", { name: "canon/moved.md" });
	expect(body("canon/moved.md")).toContain("New");
	await click(user, copy.downloadFile);
	await click(user, copy.previewFile);
	await screen.findByRole("dialog", { name: copy.preview });
	await click(user, zhCN.backstage.close, screen.getByRole("dialog"));
	await click(user, copy.remove);
	await waitFor(() => expect(body("canon/moved.md")).toBeUndefined());
	await click(user, "skills/read/SKILL.md");
	await click(user, copy.skillForm);
	fireEvent.input(screen.getByRole("textbox", { name: copy.skillBody }), {
		target: { value: "Updated skill body" },
	});
	await click(user, copy.save);
	expect(body("skills/read/SKILL.md")).toContain("Updated skill body");
	await click(user, copy.source);
	await click(user, copy.exportZip);
	expect(api.draftExport).toHaveBeenCalled();
	await click(user, copy.apply);
	const review = await screen.findByRole("dialog", { name: copy.applyReview });
	await click(user, new RegExp(copy.modified), review);
	await screen.findByText(copy.installed);
	await click(user, copy.confirmApply, review);
	await screen.findByText(copy.applied);
	await click(user, copy.backLibrary);
	await screen.findByRole("heading", { name: "Author test" });
	await click(user, copy.deleteDraft);
	expect(api.draftManage).toHaveBeenCalledWith(expect.objectContaining({ action: "delete" }));
	await click(user, copy.backChat);
	expect(onClose).toHaveBeenCalledOnce();
});

it("previews real first-meeting steps and assets without a configured model", async () => {
	const { make } = setup();
	make();
	const user = userEvent.setup();
	render(() => <CharacterStudio initialCharacterId="author-test" onClose={() => {}} />);
	await screen.findByRole("textbox", { name: `${copy.identity} ${copy.required}` });
	await click(user, copy.preview);
	const preview = screen.getByRole("dialog", { name: copy.preview });
	await within(preview).findByRole("img", { name: "Room" });
	await click(user, "Continue", preview);
	await within(preview).findByLabelText("Nickname");
	await click(user, "Done", preview);
	await click(user, "Tea · Warm", preview);
	expect(within(preview).getByRole("heading", { name: "Welcome" })).toBeVisible();
	await click(user, zhCN.backstage.close, preview);
	await click(user, copy.trial);
	await screen.findByText(copy.trialNoModels);
	await click(user, zhCN.backstage.close, screen.getByRole("dialog"));
});

it("edits optional fields, arrays, typed values, state scopes and Skill metadata using the actual Host schemas", async () => {
	const user = userEvent.setup();
	const [source, setSource] = createSignal(stringify(manifest));
	const [section, setSection] = createSignal("character");
	render(() => (
		<PackageForms
			source={source()}
			schema={schemas.manifest as EditorSchema}
			section={section()}
			onChange={setSource}
		/>
	));
	fireEvent.input(
		screen.getByRole("textbox", { name: /character\.first_meeting\.steps\.0\.heading/ }),
		{ target: { value: "Edited welcome" } },
	);
	expect(parse(source()).character.first_meeting.steps[0].heading).toBe("Edited welcome");
	setSection("media");
	await screen.findByRole("textbox", { name: /media\.0\.asset/ });
	const item = screen.getByRole("group", { name: "media [1]" });
	await click(user, copy.remove, item);
	expect(parse(source()).media).toEqual([]);
	await click(user, copy.addItem);
	expect(parse(source()).media).toHaveLength(1);
	setSection("state_schema");
	await screen.findByText(copy.stateHint);
	fireEvent.input(screen.getByLabelText(copy.fieldKey), { target: { value: "count" } });
	await click(
		user,
		copy.addItem,
		screen.getByRole("textbox", { name: copy.fieldKey }).closest("form")!,
	);
	expect(parse(source()).state_schema.properties.count["x-scope"]).toBe("conversation");
	const mood = screen.getByRole("group", { name: "mood" });
	await click(user, copy.remove, mood);
	expect(parse(source()).state_schema.properties.mood).toBeUndefined();
});

it("preserves typed values and shared fields while changing variants and reordering arrays", async () => {
	const user = userEvent.setup();
	const [value, setValue] = createSignal<unknown>({
		kind: "text",
		heading: "Keep heading",
		count: 1,
		enabled: false,
		list: ["first", "second"],
		asset: "assets/one.png",
	});
	const common = {
		heading: { type: "string" },
		count: { type: "integer", minimum: 0 },
		enabled: { type: "boolean" },
		list: { type: "array", items: { type: "string" } },
		asset: { type: "string" },
	};
	const schema: EditorSchema = {
		oneOf: [
			{
				type: "object",
				properties: { kind: { const: "text" }, ...common },
				required: ["kind", "heading", "count", "enabled", "list", "asset"],
			},
			{
				type: "object",
				properties: {
					kind: { const: "choice" },
					...common,
					choices: { type: "array", items: { type: "string" } },
				},
				required: ["kind", "heading", "choices"],
			},
		],
	};
	render(() => (
		<SchemaFields
			schema={schema}
			path="step"
			value={value()}
			required
			assets={["assets/one.png", "assets/two.png"]}
			onChange={setValue}
		/>
	));
	fireEvent.input(screen.getByRole("spinbutton"), { target: { value: "4" } });
	await selectKobalteOption(user, screen.getByRole("button", { name: /step.enabled/ }), "true");
	await selectKobalteOption(
		user,
		screen.getByRole("button", { name: new RegExp(copy.chooseAsset) }),
		"assets/two.png",
	);
	await click(user, copy.moveDown, screen.getByRole("group", { name: "step.list [1]" }));
	expect(value()).toMatchObject({
		count: 4,
		enabled: true,
		asset: "assets/two.png",
		list: ["second", "first"],
	});
	await click(user, copy.moveUp, screen.getByRole("group", { name: "step.list [2]" }));
	expect(value()).toMatchObject({ list: ["first", "second"] });
	await selectKobalteOption(
		user,
		screen.getByRole("button", { name: new RegExp(copy.variant) }),
		"choice",
	);
	expect(value()).toMatchObject({ kind: "choice", heading: "Keep heading", choices: [], count: 4 });
});

it("adds and removes record keys, switches dynamic types and recovers invalid JSON", async () => {
	const user = userEvent.setup();
	const [value, setValue] = createSignal<unknown>({});
	const [schema, setSchema] = createSignal<EditorSchema>({
		type: "object",
		additionalProperties: {},
	});
	render(() => (
		<SchemaFields schema={schema()} value={value()} path="record" required onChange={setValue} />
	));
	fireEvent.input(screen.getByLabelText(copy.fieldKey), { target: { value: "field" } });
	await click(user, copy.addItem);
	expect(value()).toEqual({ field: "" });
	await selectKobalteOption(user, screen.getByRole("button", { name: /record.field/ }), "number");
	fireEvent.input(screen.getByRole("spinbutton"), { target: { value: "2.5" } });
	expect(value()).toEqual({ field: 2.5 });
	await selectKobalteOption(user, screen.getByRole("button", { name: /record.field/ }), "boolean");
	await selectKobalteOption(user, screen.getByLabelText("field · record.field"), "true");
	expect(value()).toEqual({ field: true });
	await click(user, copy.removeField.replace("{field}", "field"));
	expect(value()).toEqual({});
	setSchema({ type: "unsupported" });
	fireEvent.input(screen.getByRole("textbox"), { target: { value: "{" } });
	expect(screen.getByRole("alert")).toHaveTextContent(copy.invalidJson);
	expect(value()).toEqual({});
	fireEvent.input(screen.getByRole("textbox"), { target: { value: '{"ok":true}' } });
	expect(screen.queryByRole("alert")).toBeNull();
	expect(value()).toEqual({ ok: true });
});

it("edits nullable unions, optional fields and actual Skill frontmatter without losing its body", async () => {
	const user = userEvent.setup();
	const [value, setValue] = createSignal<unknown>("hello");
	const nullable = render(() => (
		<SchemaFields
			schema={{ anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] }}
			value={value()}
			path="value"
			required
			onChange={setValue}
		/>
	));
	await click(user, copy.setNull);
	expect(value()).toBeNull();
	await click(user, copy.setValue);
	expect(value()).toBe("");
	await selectKobalteOption(
		user,
		screen.getByRole("button", { name: new RegExp(copy.valueType) }),
		"number",
	);
	expect(value()).toBe(0);
	nullable.unmount();
	const [source, setSource] = createSignal(skill);
	render(() => (
		<SkillFields source={source()} schema={schemas.skill as EditorSchema} onChange={setSource} />
	));
	fireEvent.input(screen.getByRole("textbox", { name: /SKILL.md.description/ }), {
		target: { value: "New description" },
	});
	expect(source()).toContain("New description");
	expect(source()).toContain("Read the supplied document.");
	await click(user, /requires/);
	expect(source()).toContain("requires:");
	await click(user, copy.removeField.replace("{field}", "requires"));
	expect(source()).not.toContain("requires:");
	setSource("No frontmatter");
	expect(screen.getByRole("alert")).toHaveTextContent(copy.skillFrontmatterHint);
});

it("requires explicit acceptance of exact state changes and passes the reviewed migration token", async () => {
	const { api, make } = setup();
	make();
	const user = userEvent.setup();
	vi.mocked(api.draftReview).mockResolvedValue({
		issues: [],
		changes: [],
		migration: {
			token: "review-token",
			changes: [
				{ scope: "global", field: "old", before: "42", after: "removed" },
				{
					scope: "conversation",
					conversationId: "session-a",
					field: "mood",
					before: "calm",
					after: "new default",
				},
			],
		},
	});
	render(() => <CharacterStudio initialCharacterId="author-test" onClose={() => {}} />);
	await screen.findByRole("textbox", { name: `${copy.identity} ${copy.required}` });
	await click(user, copy.apply);
	await screen.findByText(copy.migrationTitle);
	const confirm = screen.getByRole("button", { name: copy.confirmApply });
	expect(confirm).toBeDisabled();
	await user.click(screen.getByRole("checkbox", { name: copy.migrationAccept }));
	await click(user, copy.confirmApply);
	await waitFor(() =>
		expect(api.draftPublish).toHaveBeenCalledWith(expect.any(String), 1, "review-token"),
	);
});

it("opens a validation issue at its actual YAML field and preserves duplicate imported references", async () => {
	const { api, make } = setup();
	make();
	const user = userEvent.setup();
	vi.mocked(api.draftReview).mockResolvedValue({
		issues: [
			{ file: "character.yaml", path: "behavior.identity.summary", message: "Invalid identity" },
		],
		changes: [],
	});
	render(() => <CharacterStudio initialCharacterId="author-test" onClose={() => {}} />);
	await screen.findByRole("textbox", { name: `${copy.identity} ${copy.required}` });
	await click(user, copy.apply);
	expect(screen.getByRole("button", { name: copy.confirmApply })).toBeDisabled();
	await click(user, "character.yaml · behavior.identity.summary");
	const source = (await screen.findByRole("textbox", { name: copy.source })) as HTMLTextAreaElement;
	await waitFor(() => expect(source).toHaveFocus());
	expect(source.value.slice(source.selectionStart, source.selectionEnd)).toContain(
		"An editor fixture.",
	);
	const upload = screen.getByLabelText(copy.importCanon);
	await user.upload(upload, new File(["A second note"], "note.md", { type: "text/markdown" }));
	await waitFor(() =>
		expect(api.draftUploadFile).toHaveBeenCalledWith(
			expect.any(String),
			1,
			"canon/note-2.md",
			expect.any(File),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		),
	);
});
