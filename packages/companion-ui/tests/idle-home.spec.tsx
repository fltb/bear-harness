import { productUi } from "@bear-harness/product-config";
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
		expect(
			screen.getByPlaceholderText(productUi.shell.fallbackComposerPlaceholder),
		).toBeInTheDocument();
	});

	it("loads providers and requires a reply model before the first meeting", async () => {
		const { client, conversationList, providerList } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await waitFor(() => expect(conversationList).toHaveBeenCalled());
		await waitFor(() => expect(providerList).toHaveBeenCalled());
		expect(
			await screen.findByRole("dialog", { name: productUi.modelSetup.dialogLabel }),
		).toBeInTheDocument();
	});

	it("keeps the shell with accessibility landmarks", () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		expect(
			screen.getByRole("navigation", { name: productUi.sidebar.conversations }),
		).toBeInTheDocument();
		expect(screen.getByRole("searchbox", { name: productUi.sidebar.search })).toBeEnabled();
		expect(
			screen.getByRole("button", { name: productUi.sidebar.relationshipArchive }),
		).toBeEnabled();
		expect(screen.getByRole("button", { name: productUi.sidebar.systemSettings })).toBeEnabled();
	});

	it("opens the backstage sheet from the titlebar", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const backstage = screen.getByRole("button", { name: productUi.titlebar.backstage });
		expect(backstage).toBeEnabled();
		await user.click(backstage);
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
		expect(
			screen.getByRole("tab", { name: productUi.backstage.relationshipArchive }),
		).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: productUi.backstage.memory })).toBeInTheDocument();
		expect(
			screen.getByRole("tab", { name: productUi.backstage.systemSettings }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("tab", { name: productUi.backstage.systemSettings }));
		const useModel = screen.getByRole("button", { name: productUi.settings.useModel });
		expect(useModel).toBeInstanceOf(HTMLButtonElement);
		expect(useModel).toBeDisabled();
	});

	it("applies role theme tokens and warns without blocking on a language mismatch", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { eventSeq: 0, character: THEMED_CHARACTER } }),
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

		await user.click(screen.getByRole("button", { name: productUi.language.dismiss }));
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
});
