import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT, THEMED_CHARACTER } from "./fixtures.js";

describe("idle homepage (official config, no bridge)", () => {
	it("renders app title and the shell frame", () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		expect(document.title).toBe("Cyber Bear");
		// Without a bridge, character data is absent — the shell shows the
		// scene area and accessible controls but no character-specific copy.
		expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
		expect(screen.getByPlaceholderText(zhCN.shell.fallbackComposerPlaceholder)).toBeInTheDocument();
	});

	it("loads providers and requires a reply model before the first meeting", async () => {
		const { client, conversationList, providerList } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					model: { pool: { models: [] }, defaults: { vision: { mode: "auto" } } },
				},
			}),
		);
		client.model.poolGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { models: [] } }),
		);
		client.model.defaultsGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { vision: { mode: "auto" as const } } }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await waitFor(() => expect(conversationList).toHaveBeenCalled());
		await waitFor(() => expect(providerList).toHaveBeenCalled());
		expect(
			await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel }),
		).toBeInTheDocument();
	});

	it("keeps the shell with accessibility landmarks", () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		expect(
			screen.getByRole("navigation", { name: zhCN.sidebar.conversations }),
		).toBeInTheDocument();
		expect(screen.getByRole("searchbox", { name: zhCN.sidebar.search })).toBeEnabled();
		expect(screen.getByRole("button", { name: zhCN.sidebar.characterSettings })).toBeEnabled();
		expect(screen.getByRole("button", { name: zhCN.sidebar.systemSettings })).toBeEnabled();
	});

	it("opens the backstage sheet from the sidebar", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const backstage = screen.getByRole("button", { name: zhCN.sidebar.characterSettings });
		expect(backstage).toBeEnabled();
		await user.click(backstage);
		expect(
			await screen.findByRole("dialog", { name: zhCN.sidebar.characterSettings }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("tab", { name: zhCN.backstage.roleManagement }),
		).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: zhCN.backstage.memory })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: zhCN.backstage.close }));
		await waitFor(() =>
			expect(
				screen.queryByRole("dialog", { name: zhCN.sidebar.characterSettings }),
			).not.toBeInTheDocument(),
		);
		await user.click(
			screen.getByRole("button", { name: zhCN.sidebar.systemSettings, hidden: true }),
		);
		await screen.findByRole("dialog", { name: zhCN.sidebar.systemSettings });
		expect(
			screen.getByRole("region", { name: zhCN.settings.providerSetupLabel }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: zhCN.settings.addModel }),
		).not.toBeInTheDocument();
	});

	it("applies role theme tokens and warns without blocking on a language mismatch", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					character: THEMED_CHARACTER,
					model: {
						models: [
							{
								providerId: "test-provider",
								modelId: "test-model",
								label: "Test Model",
								supportsImages: true,
								createdAt: "2026-01-01 00:00:00",
							},
						],
					},
				},
			}),
		);
		Object.defineProperty(window.navigator, "languages", {
			configurable: true,
			value: ["en-US"],
		});

		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const warning = await screen.findByRole("status");
		expect(warning).toHaveTextContent("ja-JP");
		expect(warning).toHaveTextContent("en-US");
		const app = screen.getByRole("application", { name: OFFICIAL_PRODUCT.productName });
		expect(app?.style.getPropertyValue("--accent")).toBe("#42c7a5");
		expect(screen.getByPlaceholderText("Message")).toBeInTheDocument();
		expect(warning).not.toHaveAttribute("aria-modal");

		await user.click(screen.getByRole("button", { name: zhCN.language.dismiss }));
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
});
