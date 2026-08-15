import { productUi } from "@bear-harness/product-config";
import { render, screen } from "@solidjs/testing-library";
import { waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";

/**
 * Regression guard for the relationship-memory switch (幕后 · 系统设置):
 * the `role=switch` control must stay operable — by mouse click and by
 * keyboard — and every activation must push the patch through the injected
 * client's `settings.set`, after which the UI re-reads the host's canonical
 * settings instead of trusting local state.
 */
describe("relationship memory switch", () => {
	it("is click- and keyboard-operable and drives the client-backed settings mutation", async () => {
		const user = userEvent.setup();
		const { client, settingsSet } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		// Open the backstage sheet, then its 系统设置 tab (default is 关系档案).
		await user.click(await screen.findByRole("button", { name: productUi.titlebar.backstage }));
		await user.click(await screen.findByRole("tab", { name: productUi.backstage.systemSettings }));

		const toggle = await screen.findByRole("switch", {
			name: productUi.settings.relationshipMemory,
		});
		// The switch stays disabled until the first settings read resolves.
		await waitFor(() => expect(toggle).toBeEnabled());

		// Mouse click toggles it on through the client mutation.
		await user.click(toggle);
		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith({ relationshipMemoryEnabled: true }),
		);
		await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));

		// Keyboard: Space on the focused switch toggles it back off the same way.
		toggle.focus();
		await user.keyboard(" ");
		await waitFor(() =>
			expect(settingsSet).toHaveBeenLastCalledWith({ relationshipMemoryEnabled: false }),
		);
		await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
	});

	it("keeps the canonical value and exposes an alert when persistence fails", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		client.settings.set = vi.fn(() =>
			Promise.resolve({
				ok: false as const,
				error: { kind: "internal" as const, reason: "settings_write_failed" },
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await user.click(await screen.findByRole("button", { name: productUi.titlebar.backstage }));
		await user.click(await screen.findByRole("tab", { name: productUi.backstage.systemSettings }));
		const toggle = await screen.findByRole("switch", {
			name: productUi.settings.relationshipMemory,
		});
		await waitFor(() => expect(toggle).toBeEnabled());
		await user.click(toggle);

		expect(await screen.findByRole("alert")).toHaveTextContent(productUi.errors.generic);
		expect(toggle).toHaveAttribute("aria-checked", "false");
	});
});
