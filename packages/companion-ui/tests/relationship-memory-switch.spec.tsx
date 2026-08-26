import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen } from "@solidjs/testing-library";
import { waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT, THEMED_CHARACTER } from "./fixtures.js";

/**
 * Regression guard for the relationship-memory switch (角色管理 · 角色记忆):
 * the `role=switch` control must stay operable — by mouse click and by
 * keyboard — and every activation must push the patch through the injected
 * client's `settings.set`, after which the UI re-reads the host's canonical
 * settings instead of trusting local state.
 */
describe("relationship memory switch", () => {
	const configureSelectedPackage = (client: ReturnType<typeof createTestClient>["client"]) => {
		client.character.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					characters: [
						{
							id: THEMED_CHARACTER.id,
							name: THEMED_CHARACTER.name,
							version: "1",
							subtitle: THEMED_CHARACTER.character.subtitle,
							avatarUrl: THEMED_CHARACTER.visual.avatarUrl,
							active: true,
						},
					],
				},
			}),
		);
		client.character.packageGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					package: {
						characterId: THEMED_CHARACTER.id,
						origin: "local" as const,
						writable: true,
						yaml: "prompt:\n  description: Test description\n  personality: Test personality\n  scenario: Test scenario\n  system_prompt: Test system prompt\n  mes_example: ''\nroleplay: {}\n",
						sha256: "a".repeat(64),
						character: THEMED_CHARACTER,
					},
				},
			}),
		);
	};

	it("is click- and keyboard-operable and drives the client-backed settings mutation", async () => {
		const user = userEvent.setup();
		const { client, settingsSet } = createTestClient();
		configureSelectedPackage(client);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await user.click(await screen.findByRole("button", { name: zhCN.sidebar.characterSettings }));
		await user.click(await screen.findByRole("tab", { name: zhCN.currentRolePackage.memoryTab }));

		const toggle = await screen.findByRole("switch", {
			name: zhCN.currentRolePackage.relationshipMemory,
		});
		// The switch stays disabled until the first settings read resolves.
		await waitFor(() => expect(toggle).toBeEnabled());

		// Mouse click toggles it on through the client mutation.
		await user.click(toggle);
		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith({
				characterId: THEMED_CHARACTER.id,
				settings: { relationshipMemoryEnabled: true },
			}),
		);
		await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));

		// Keyboard: Space on the focused switch toggles it back off the same way.
		toggle.focus();
		await user.keyboard(" ");
		await waitFor(() =>
			expect(settingsSet).toHaveBeenLastCalledWith({
				characterId: THEMED_CHARACTER.id,
				settings: { relationshipMemoryEnabled: false },
			}),
		);
		await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
	});

	it("keeps the canonical value and exposes an alert when persistence fails", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		configureSelectedPackage(client);
		client.settings.set = vi.fn(() =>
			Promise.resolve({
				ok: false as const,
				error: { kind: "internal" as const, reason: "settings_write_failed" },
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await user.click(await screen.findByRole("button", { name: zhCN.sidebar.characterSettings }));
		await user.click(await screen.findByRole("tab", { name: zhCN.currentRolePackage.memoryTab }));
		const toggle = await screen.findByRole("switch", {
			name: zhCN.currentRolePackage.relationshipMemory,
		});
		await waitFor(() => expect(toggle).toBeEnabled());
		await user.click(toggle);

		expect(await screen.findByRole("alert")).toHaveTextContent(zhCN.errors.generic);
		expect(toggle).toHaveAttribute("aria-checked", "false");
	});
});
