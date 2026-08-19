import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";

function selectTrigger(container: HTMLElement, label: string): HTMLElement {
	const trigger = within(container)
		.getAllByRole("button")
		.find((button) => button.getAttribute("aria-label") === label);
	if (!trigger) throw new Error(`select trigger missing: ${label}`);
	return trigger;
}

async function openSettings() {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: zhCN.sidebar.systemSettings }));
	const backstage = await screen.findByRole("dialog");
	await user.click(
		within(backstage).getByRole("tab", { name: zhCN.backstage.systemSettings }),
	);
	return { user, backstage };
}

function waitForSettings(container: HTMLElement): Promise<void> {
	// Kobalte Select triggers render as <button> with role=null, not combobox.
	// Wait for the proxy mode trigger to appear.
	return waitFor(() => {
		const triggers = within(container).getAllByRole("button");
		expect(triggers.some((b) => b.getAttribute("aria-label") === "代理模式")).toBe(true);
	});
}

describe("NetworkAndMemorySettings", () => {
	it("renders proxy mode, memory vector, and download mirror sections", async () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage } = await openSettings();
		await waitForSettings(backstage);

		expect(within(backstage).getByRole("heading", { name: zhCN.settings.networkSection })).toBeTruthy();
		expect(within(backstage).getByRole("heading", { name: zhCN.settings.memoryVectorSection })).toBeTruthy();
		expect(within(backstage).getByRole("heading", { name: zhCN.settings.downloadMirrorSection })).toBeTruthy();
	});

	it("loads proxy settings from the store on mount", async () => {
		const { client } = createTestClient();
		client.settings.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					settings: {
						networkProxy: { mode: "manual", url: "http://127.0.0.1:7890" },
					},
				},
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage } = await openSettings();
		await waitForSettings(backstage);

		expect(selectTrigger(backstage, "代理模式").textContent).toContain("手动");
		expect(within(backstage).getByPlaceholderText("http://127.0.0.1:7890")).toBeTruthy();
	});

	it("toggles vector memory enabled and shows provider options", async () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await waitForSettings(backstage);

		const checkbox = within(backstage).getByRole("checkbox", { name: zhCN.settings.memoryVectorEnabled });
		expect(checkbox).not.toBeChecked();

		await user.click(checkbox);
		await waitFor(() => expect(checkbox).toBeChecked());

		expect(selectTrigger(backstage, "服务类型")).toBeTruthy();
	});

	it("saves proxy changes via settings.set", async () => {
		const { client, settingsSet } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await waitForSettings(backstage);

		const proxySelect = selectTrigger(backstage, "代理模式");
		await user.click(proxySelect);
		const manualOption = await waitFor(
			() => [...screen.getAllByRole("option")].find((el) => el.textContent?.trim() === "manual"),
			{ timeout: 3000 },
		);
		expect(manualOption).toBeTruthy();
		await user.click(manualOption!);

		const proxyUrlField = within(backstage).getByPlaceholderText("http://127.0.0.1:7890");
		await user.clear(proxyUrlField);
		await user.type(proxyUrlField, "http://proxy.example.com:8080");

		await user.click(within(backstage).getByRole("button", { name: zhCN.settings.saveNetwork }));

		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith(
				expect.objectContaining({
					settings: expect.objectContaining({
						networkProxy: { mode: "manual", url: "http://proxy.example.com:8080" },
					}),
				}),
			),
		);
	});

	it("saves memory vector service changes via settings.set", async () => {
		const { client, settingsSet } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await waitForSettings(backstage);

		await user.click(within(backstage).getByRole("checkbox", { name: zhCN.settings.memoryVectorEnabled }));

		const providerSelect = selectTrigger(backstage, "服务类型");
		await user.click(providerSelect);
		const localOption = await waitFor(
			() =>
				[...screen.getAllByRole("option")].find(
					(el) => el.textContent?.trim() === "local" || el.getAttribute("data-key") === "local",
				),
			{ timeout: 3000 },
		);
		expect(localOption).toBeTruthy();
		await user.click(localOption!);

		await user.click(within(backstage).getByRole("button", { name: zhCN.settings.saveNetwork }));

		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith(
				expect.objectContaining({
					settings: expect.objectContaining({
						memoryVectorService: {
							enabled: true,
							provider: "local",
							localModel: "embeddinggemma",
						},
					}),
				}),
			),
		);
	});

	it("shows feedback on successful save", async () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await waitForSettings(backstage);

		await user.click(within(backstage).getByRole("button", { name: zhCN.settings.saveNetwork }));

		await waitFor(() => {
			expect(within(backstage).getByRole("status")).toHaveTextContent(zhCN.settings.saved);
		});
	});

	it("shows error on failed save", async () => {
		const { client } = createTestClient();
		client.settings.set = vi.fn(() =>
			Promise.resolve({
				ok: false as const,
				error: { kind: "internal" as const, reason: "settings_write_failed" },
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await waitForSettings(backstage);

		await user.click(within(backstage).getByRole("button", { name: zhCN.settings.saveNetwork }));

		await waitFor(() => {
			expect(within(backstage).getByRole("alert")).toBeTruthy();
		});
	});

	it("download mirror field is editable", async () => {
		const { client, settingsSet } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await waitForSettings(backstage);

		const mirrorField = within(backstage).getByRole("textbox", { name: zhCN.settings.downloadMirrorLabel });
		await user.clear(mirrorField);
		await user.type(mirrorField, "https://mirror.example.com/hf");

		await user.click(within(backstage).getByRole("button", { name: zhCN.settings.saveNetwork }));

		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith(
				expect.objectContaining({
					settings: expect.objectContaining({
						modelDownloadMirror: { endpoint: "https://mirror.example.com/hf" },
					}),
				}),
			),
		);
	});
});