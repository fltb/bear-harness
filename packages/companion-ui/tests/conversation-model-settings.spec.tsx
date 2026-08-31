import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConversationModelSettings } from "../src/features/ConversationModelSettings.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import type { ConfiguredModel, ModelListData } from "../src/stores/ipc.js";
import { selectKobalteOption } from "./kobalte-helpers.js";

const TEXT_MODEL: ConfiguredModel = {
	providerId: "alpha",
	providerName: "Alpha",
	modelId: "text",
	label: "Text",
	supportsImages: false,
	createdAt: "2026-01-01",
};
const VISION_MODEL: ConfiguredModel = {
	providerId: "beta",
	providerName: "Beta",
	modelId: "vision",
	label: "Vision",
	supportsImages: true,
	createdAt: "2026-01-02",
};
const FALLBACK_MODEL: ConfiguredModel = {
	providerId: "fallback",
	providerName: "Fallback",
	modelId: "image",
	label: "Fallback Image",
	supportsImages: true,
	createdAt: "2026-01-03",
};

function modelData(overrides: Partial<ModelListData> = {}): ModelListData {
	return {
		models: [TEXT_MODEL, VISION_MODEL],
		selected: { providerId: TEXT_MODEL.providerId, modelId: TEXT_MODEL.modelId },
		defaults: { vision: { mode: "auto" } },
		...overrides,
	};
}

function renderSettings(
	options: {
		activeConversationId?: string | null;
		data?: (() => ModelListData) | undefined;
		models?: (() => ConfiguredModel[]) | undefined;
		select?: CompanionStore["model"]["select"];
		setMultimodalFallback?: CompanionStore["model"]["setMultimodalFallback"];
		setVisionAuto?: CompanionStore["model"]["setVisionAuto"];
	} = {},
) {
	const select = options.select ?? vi.fn(() => Promise.resolve());
	const setMultimodalFallback = options.setMultimodalFallback ?? vi.fn(() => Promise.resolve());
	const setVisionAuto = options.setVisionAuto ?? vi.fn(() => Promise.resolve());
	const store = {
		activeConversationId:
			options.activeConversationId === undefined ? "conversation-1" : options.activeConversationId,
		model: {
			data: Object.hasOwn(options, "data") ? options.data : () => modelData(),
			models: Object.hasOwn(options, "models") ? options.models : () => [FALLBACK_MODEL],
			select,
			setMultimodalFallback,
			setVisionAuto,
		},
	} as unknown as CompanionStore;
	const view = render(() => (
		<DesktopProvider store={store}>
			<ConversationModelSettings />
		</DesktopProvider>
	));
	return { ...view, select, setMultimodalFallback, setVisionAuto };
}

describe("ConversationModelSettings", () => {
	it("routes reply and image-reader selections and reports both successful updates", async () => {
		const user = userEvent.setup();
		const actions = renderSettings();

		expect(
			screen.getByRole("heading", { name: zhCN.settings.conversationModelSettings }),
		).toBeVisible();
		expect(screen.getByText(zhCN.settings.conversationModelSettingsHint)).toBeVisible();
		expect(screen.getByLabelText(zhCN.settings.currentReplyModel)).toHaveTextContent(
			"Text (Alpha)",
		);
		expect(screen.getByLabelText(zhCN.settings.visionModel)).toHaveTextContent(
			zhCN.settings.visionModelAuto,
		);

		await selectKobalteOption(user, screen.getByLabelText(zhCN.settings.currentReplyModel), {
			label: "Vision (Beta)",
		});
		await waitFor(() =>
			expect(actions.select).toHaveBeenCalledWith("conversation-1", "beta", "vision"),
		);
		expect(screen.getByRole("status")).toHaveTextContent(zhCN.settings.modelSaved);

		await selectKobalteOption(user, screen.getByLabelText(zhCN.settings.visionModel), {
			label: "Vision (Beta)",
		});
		await waitFor(() =>
			expect(actions.setMultimodalFallback).toHaveBeenCalledWith("beta", "vision"),
		);
		expect(screen.getByRole("status")).toHaveTextContent(zhCN.settings.imageReaderUpdated);
		expect(screen.queryByText("Fallback Image (Fallback)")).not.toBeInTheDocument();
	});

	it("disables conversation routing with no active conversation but keeps image settings usable", async () => {
		const user = userEvent.setup();
		const actions = renderSettings({
			activeConversationId: null,
			data: () => modelData({ models: [] }),
			models: () => [FALLBACK_MODEL],
		});

		expect(screen.getByText(zhCN.settings.noActiveConversationModel)).toBeVisible();
		expect(screen.getByLabelText(zhCN.settings.currentReplyModel)).toBeDisabled();
		expect(screen.getByLabelText(zhCN.settings.visionModel)).toBeEnabled();
		await selectKobalteOption(user, screen.getByLabelText(zhCN.settings.visionModel), {
			label: "Fallback Image (Fallback)",
		});
		expect(actions.setMultimodalFallback).toHaveBeenCalledWith("fallback", "image");
		expect(actions.select).not.toHaveBeenCalled();
	});

	it("returns a manual image route to automatic reply-model handling", async () => {
		const user = userEvent.setup();
		const actions = renderSettings({
			data: () =>
				modelData({
					defaults: {
						vision: {
							mode: "manual",
							route: { providerId: "beta", modelId: "vision" },
						},
					},
				}),
		});

		expect(screen.getByLabelText(zhCN.settings.visionModel)).toHaveTextContent("Vision (Beta)");
		await selectKobalteOption(
			user,
			screen.getByLabelText(zhCN.settings.visionModel),
			zhCN.settings.visionModelAuto,
		);
		await waitFor(() => expect(actions.setVisionAuto).toHaveBeenCalledOnce());
		expect(actions.setMultimodalFallback).not.toHaveBeenCalled();
		expect(screen.getByRole("status")).toHaveTextContent(zhCN.settings.imageReaderUpdated);
	});

	it("locks both selectors while a reply route is saving", async () => {
		const user = userEvent.setup();
		let finish: (() => void) | undefined;
		const select = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		renderSettings({ select });

		await selectKobalteOption(user, screen.getByLabelText(zhCN.settings.currentReplyModel), {
			label: "Vision (Beta)",
		});
		expect(screen.getByLabelText(zhCN.settings.currentReplyModel)).toBeDisabled();
		expect(screen.getByLabelText(zhCN.settings.visionModel)).toBeDisabled();
		finish?.();
		await waitFor(() =>
			expect(screen.getByLabelText(zhCN.settings.currentReplyModel)).toBeEnabled(),
		);
	});

	it.each([
		[{ message: "路由失败", reason: "离线" }, "路由失败 (离线)"],
		[new Error("切换失败"), "切换失败"],
		["普通失败", "普通失败"],
	])("shows actionable failures from model updates", async (cause, message) => {
		const user = userEvent.setup();
		renderSettings({ select: vi.fn(() => Promise.reject(cause)) });
		await selectKobalteOption(user, screen.getByLabelText(zhCN.settings.currentReplyModel), {
			label: "Vision (Beta)",
		});
		expect(await screen.findByRole("alert")).toHaveTextContent(message);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(screen.getByLabelText(zhCN.settings.currentReplyModel)).toBeEnabled();
	});

	it("renders an empty model surface when optional model readers are absent", () => {
		renderSettings({ activeConversationId: null, data: undefined, models: undefined });
		expect(screen.getByLabelText(zhCN.settings.currentReplyModel)).toBeDisabled();
		expect(screen.getByLabelText(zhCN.settings.visionModel)).toHaveTextContent(
			zhCN.settings.visionModelAuto,
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
