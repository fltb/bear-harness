import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConversationStatePanel } from "../src/ConversationStatePanel.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import type { CompanionStateData } from "../src/stores/ipc.js";
import { selectKobalteOption } from "./kobalte-helpers.js";

const schema = {
	type: "object",
	title: "角色脉络",
	description: "只展示这一条会话的角色状态",
	properties: {
		profile: {
			type: "object",
			title: "关系",
			description: "当前关系资料",
			properties: {
				"alias/~": {
					type: "string",
					title: "称呼",
					description: "对方使用的称呼",
					"x-user-editable": true,
				},
				notes: {
					type: "array",
					title: "备注",
					"x-user-editable": true,
				},
				score: {
					type: "number",
					title: "信任值",
					"x-user-editable": true,
				},
				mood: {
					title: "语气",
					oneOf: [
						{ const: "calm", title: "平静" },
						{ const: "bright", title: "明快" },
					],
					"x-user-editable": true,
				},
				consent: {
					type: "boolean",
					title: "记忆许可",
					"x-user-editable": true,
				},
				lockedMode: {
					title: "锁定模式",
					readOnly: true,
					oneOf: [
						{ const: "guarded", title: "谨慎" },
						{ const: "open", title: "坦率" },
					],
					"x-user-editable": true,
				},
				immutableBool: { type: "boolean", title: "系统开关" },
				emptyList: { type: "array", title: "空列表" },
				emptyText: { type: "string", title: "空文本" },
				chapter: { $ref: "#/$defs/chapter" },
			},
		},
	},
	$defs: {
		chapter: {
			type: "object",
			title: "章节",
			description: "嵌套引用",
			properties: {
				name: { type: "string", title: "章节名", "x-user-editable": true },
			},
		},
	},
};

const projection: CompanionStateData = {
	schema,
	state: {
		character: {
			document: {
				profile: {
					"alias/~": "旧称呼",
					notes: ["第一条", "第二条"],
					score: 2,
					mood: "calm",
					consent: false,
					lockedMode: "guarded",
					immutableBool: true,
					emptyList: [],
					emptyText: "",
					chapter: { name: "序章" },
				},
			},
			revisions: { conversation: 7, global: 3 },
			schemaHash: "a".repeat(64),
		},
		display: {
			sceneId: "default",
			expressionId: "default",
		},
		revisions: { display: 1 },
	},
};

function renderPanel(
	options: {
		state?: CompanionStateData;
		update?: CompanionStore["updateCompanionState"];
		onOpenChange?: (open: boolean) => void;
	} = {},
) {
	const updateCompanionState = options.update ?? vi.fn(() => Promise.resolve());
	const onOpenChange = options.onOpenChange ?? vi.fn();
	const store = {
		companionState: Object.hasOwn(options, "state") ? options.state : projection,
		updateCompanionState,
	} as unknown as CompanionStore;
	const view = render(() => (
		<DesktopProvider store={store}>
			<ConversationStatePanel open onOpenChange={onOpenChange} />
		</DesktopProvider>
	));
	return { ...view, updateCompanionState, onOpenChange };
}

function field(label: string): HTMLElement {
	const heading = screen.getByText(label);
	const container = heading.closest(".conversation-state-field");
	if (!container) throw new Error(`state field missing: ${label}`);
	return container as HTMLElement;
}

describe("ConversationStatePanel", () => {
	it("projects schema metadata and closes without inventing an empty state", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		renderPanel({ state: undefined, onOpenChange });

		const dialog = screen.getByRole("dialog", { name: zhCN.conversationState.title });
		expect(within(dialog).getByText(zhCN.conversationState.description)).toBeVisible();
		expect(within(dialog).queryByText(zhCN.conversationState.save)).not.toBeInTheDocument();
		await user.click(within(dialog).getByRole("button", { name: zhCN.conversationState.close }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("renders nested and referenced controls and commits only editable changes", async () => {
		const user = userEvent.setup();
		let finish: (() => void) | undefined;
		const update = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		renderPanel({ update });

		const dialog = screen.getByRole("dialog", { name: schema.title });
		expect(within(dialog).getByText(schema.description)).toBeVisible();
		expect(
			within(dialog).getByRole("heading", { name: schema.properties.profile.title, level: 3 }),
		).toBeVisible();
		expect(
			within(dialog).getByRole("heading", { name: schema.$defs.chapter.title, level: 4 }),
		).toBeVisible();
		expect(within(dialog).getByText(schema.$defs.chapter.description)).toBeVisible();
		expect(within(field("锁定模式")).getByText("谨慎", { selector: "output" })).toBeVisible();
		expect(within(field("系统开关")).getByText(zhCN.conversationState.enabled)).toBeVisible();
		expect(within(field("空列表")).getByText(zhCN.conversationState.empty)).toBeVisible();
		expect(within(field("空文本")).getByText(zhCN.conversationState.empty)).toBeVisible();
		expect(within(dialog).getByText(`${zhCN.conversationState.revision} 7`)).toBeVisible();
		const save = within(dialog).getByRole("button", { name: zhCN.conversationState.save });
		expect(save).toBeDisabled();

		const alias = within(field("称呼")).getByRole("textbox");
		await user.clear(alias);
		await user.type(alias, "新称呼");
		const notes = within(field("备注")).getByRole("textbox");
		await user.clear(notes);
		await user.type(notes, "保留\n\n新增");
		const score = within(field("信任值")).getByRole("textbox");
		await user.clear(score);
		await user.type(score, "9");
		const chapter = within(field("章节名")).getByRole("textbox");
		await user.clear(chapter);
		await user.type(chapter, "重逢");
		await selectKobalteOption(user, within(field("语气")).getByRole("button"), "明快");
		await selectKobalteOption(
			user,
			within(field("记忆许可")).getByRole("button"),
			zhCN.conversationState.enabled,
		);

		await user.click(save);
		expect(update).toHaveBeenCalledWith([
			{ path: "/character/profile/alias~1~0", value: "新称呼" },
			{ path: "/character/profile/notes", value: ["保留", "新增"] },
			{ path: "/character/profile/score", value: 9 },
			{ path: "/character/profile/mood", value: "bright" },
			{ path: "/character/profile/consent", value: true },
			{ path: "/character/profile/chapter/name", value: "重逢" },
		]);
		expect(
			within(dialog).getByRole("button", { name: zhCN.conversationState.saving }),
		).toBeDisabled();
		finish?.();
		await waitFor(() =>
			expect(
				within(dialog).getByRole("button", { name: zhCN.conversationState.save }),
			).toBeEnabled(),
		);
	});

	it.each([
		[new Error("写入失败"), "写入失败"],
		["非标准失败", "非标准失败"],
	])("surfaces a failed patch without losing the draft", async (cause, message) => {
		const user = userEvent.setup();
		const update = vi.fn(() => Promise.reject(cause));
		renderPanel({ update });
		const alias = within(field("称呼")).getByRole("textbox");
		await user.clear(alias);
		await user.type(alias, "仍在草稿中");
		await user.click(screen.getByRole("button", { name: zhCN.conversationState.save }));

		expect(await screen.findByRole("alert")).toHaveTextContent(message);
		expect(alias).toHaveValue("仍在草稿中");
		expect(screen.getByRole("button", { name: zhCN.conversationState.save })).toBeEnabled();
	});

	it("omits the editor when a projection arrives without a schema", () => {
		renderPanel({ state: { ...projection, schema: undefined as never } });
		expect(screen.getByRole("dialog", { name: zhCN.conversationState.title })).toBeVisible();
		expect(screen.queryByText(`${zhCN.conversationState.revision} 7`)).not.toBeInTheDocument();
	});
});
