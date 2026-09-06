import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import type { SettingsData } from "../src/stores/companion.js";
import { createTestClient, OFFICIAL_PRODUCT, pushHostEvent } from "./fixtures.js";

const target = { kind: "candidate" as const, candidateId: "test-embedding" };
const candidate = {
	id: target.candidateId,
	name: "Test embedding",
	dimensions: 768,
	isDefault: true,
	target,
	installed: false,
};
const disabledSettings: SettingsData = {
	firstRunStage: "role",
	relationshipMemoryEnabled: false,
	networkProxy: { mode: "direct" },
	memoryVectorService: { enabled: false, provider: "none" },
	modelDownloadSource: { type: "official" },
};
const localSettings: SettingsData = {
	...disabledSettings,
	relationshipMemoryEnabled: true,
	memoryVectorService: { enabled: true, provider: "local", localModel: target.candidateId },
};
const remoteSettings: SettingsData = {
	...disabledSettings,
	relationshipMemoryEnabled: true,
	memoryVectorService: {
		enabled: true,
		provider: "remote",
		baseUrl: "https://embedding.example/v1",
		model: "current-model",
		dimensions: 64,
		hasCredential: true,
	},
};

function selectTrigger(container: HTMLElement, label: string): HTMLElement {
	const trigger = within(container)
		.getAllByRole("button")
		.find((button) => button.getAttribute("aria-label") === label);
	if (!trigger) throw new Error(`select trigger missing: ${label}`);
	return trigger;
}

async function openSettings(page: "network" | "memory" = "memory") {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: zhCN.sidebar.systemSettings }));
	const backstage = await screen.findByRole("dialog", { name: zhCN.sidebar.systemSettings });
	await user.click(
		within(backstage).getByRole("button", {
			name: page === "network" ? zhCN.settings.networkSection : zhCN.settings.memoryVectorSection,
		}),
	);
	return { user, backstage };
}

function waitForSettings(container: HTMLElement): Promise<void> {
	return waitFor(() => {
		const proxyReady = within(container)
			.getAllByRole("button")
			.some((button) => button.getAttribute("aria-label") === zhCN.settings.proxyMode);
		const memoryReady = within(container).queryByRole("radiogroup", {
			name: zhCN.settings.vectorProvider,
		});
		expect(proxyReady || memoryReady !== null).toBe(true);
	});
}

function networkSaveButton(backstage: HTMLElement): HTMLElement {
	const network = within(backstage).getByRole("region", { name: zhCN.settings.networkSection });
	return within(network).getByRole("button", { name: zhCN.settings.saveNetwork });
}

function embeddingSettings(backstage: HTMLElement): HTMLElement {
	return within(backstage).getByRole("region", { name: zhCN.settings.memoryVectorSection });
}

async function reopenMemory(backstage: HTMLElement, user: UserEvent) {
	await user.click(within(backstage).getByRole("button", { name: zhCN.settings.networkSection }));
	await user.click(
		within(backstage).getByRole("button", { name: zhCN.settings.memoryVectorSection }),
	);
	await waitForSettings(backstage);
}

describe("NetworkAndMemorySettings", () => {
	it("renders proxy mode and integrated embedding acquisition controls", async () => {
		const { client } = createTestClient();
		client.settings.get = vi
			.fn()
			.mockResolvedValue({ ok: true, data: { settings: disabledSettings } });
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings("network");
		await waitForSettings(backstage);
		expect(
			within(backstage).getByRole("heading", { name: zhCN.settings.networkSection }),
		).toBeVisible();
		await user.click(
			within(backstage).getByRole("button", { name: zhCN.settings.memoryVectorSection }),
		);
		const embedding = embeddingSettings(backstage);
		await user.click(
			within(embedding).getByRole("radio", { name: zhCN.settings.vectorProviders.local }),
		);
		expect(selectTrigger(embedding, zhCN.settings.localModel)).toHaveTextContent(candidate.name);
		expect(selectTrigger(embedding, zhCN.settings.downloadMirrorLabel)).toHaveTextContent(
			zhCN.settings.downloadSources.official,
		);
		expect(
			within(embedding).getByRole("button", { name: zhCN.settings.downloadAndEnableLocalModel }),
		).toBeEnabled();
		expect(within(embedding).queryByRole("checkbox")).not.toBeInTheDocument();
	});

	it("shows an enabled local model from the active inventory without downloading again", async () => {
		const { client } = createTestClient();
		client.settings.get = vi
			.fn()
			.mockResolvedValue({ ok: true, data: { settings: localSettings } });
		client.memory.localEmbeddingInventory = vi.fn().mockResolvedValue({
			ok: true,
			data: { candidates: [{ ...candidate, installed: true }], activeTarget: target },
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage } = await openSettings();
		const embedding = embeddingSettings(backstage);
		expect(
			await within(embedding).findByRole("button", { name: zhCN.settings.localModelEnabled }),
		).toBeDisabled();
		expect(
			within(embedding).queryByRole("button", { name: zhCN.settings.downloadAndEnableLocalModel }),
		).not.toBeInTheDocument();
		expect(client.memory.localEmbeddingAcquisitionStart).not.toHaveBeenCalled();
	});

	it("activates an installed model without downloading or a separate memory consent toggle", async () => {
		const { client } = createTestClient();
		client.memory.localEmbeddingInventory = vi.fn().mockResolvedValue({
			ok: true,
			data: { candidates: [{ ...candidate, installed: true }] },
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await user.click(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.local }),
		);
		await user.click(
			within(backstage).getByRole("button", { name: zhCN.settings.enableLocalModel }),
		);
		await waitFor(() =>
			expect(client.memory.activateLocalEmbedding).toHaveBeenCalledWith({ target }),
		);
		expect(client.memory.localEmbeddingAcquisitionStart).not.toHaveBeenCalled();
		expect(
			within(backstage).queryByRole("checkbox", { name: zhCN.settings.memoryVectorEnabled }),
		).not.toBeInTheDocument();
		await reopenMemory(backstage, user);
		expect(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.local }),
		).toBeChecked();
	});

	it("renders Host provider capabilities and applies a remote preset only on explicit save", async () => {
		const { client, settingsSet } = createTestClient();
		client.settings.get = vi
			.fn()
			.mockResolvedValue({ ok: true, data: { settings: remoteSettings } });
		client.settings.capabilitiesGet = vi.fn().mockResolvedValue({
			ok: true,
			data: {
				networkProxyModes: [{ id: "manual" }],
				memoryVectorProviders: [{ id: "remote", onboarding: false }],
				memoryVectorPresets: [
					{ id: "bge-m3", model: "host-only-embedding-model", dimensions: 777 },
				],
				localEmbeddingCandidates: [],
			},
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings("network");
		await user.click(selectTrigger(backstage, zhCN.settings.proxyMode));
		const listbox = await screen.findByRole("listbox", { name: zhCN.settings.proxyMode });
		expect(
			within(listbox)
				.getAllByRole("option")
				.map((option) => option.textContent?.trim()),
		).toEqual([
			zhCN.settings.proxyModes.direct,
			zhCN.settings.proxyModes.auto,
			zhCN.settings.proxyModes.manual,
		]);
		await user.click(screen.getByRole("option", { name: zhCN.settings.proxyModes.manual }));
		await user.click(
			within(backstage).getByRole("button", { name: zhCN.settings.memoryVectorSection }),
		);
		expect(
			within(backstage)
				.getAllByRole("radio")
				.map((radio) => radio.getAttribute("value")),
		).toEqual(["remote"]);
		const apiKey = within(backstage).getByLabelText(zhCN.settings.apiKeyLabel);
		expect(apiKey).toHaveValue("");
		expect(apiKey).toHaveAttribute("placeholder", zhCN.settings.apiKeyStoredPlaceholder);
		await user.click(selectTrigger(backstage, zhCN.settings.vectorPreset));
		await user.click(
			await screen.findByRole("option", { name: zhCN.settings.vectorPresetLabels["bge-m3"] }),
		);
		expect(within(backstage).getByLabelText(zhCN.settings.vectorModel)).toHaveValue(
			"host-only-embedding-model",
		);
		expect(within(backstage).getByLabelText(zhCN.settings.vectorDimensions)).toHaveValue(777);
		expect(settingsSet).not.toHaveBeenCalled();
		await user.click(within(backstage).getByRole("button", { name: zhCN.settings.saveEmbedding }));
		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith({
				settings: {
					memoryVectorService: {
						enabled: true,
						provider: "remote",
						baseUrl: "https://embedding.example/v1",
						model: "host-only-embedding-model",
						dimensions: 777,
					},
				},
			}),
		);
		const patch = settingsSet.mock.calls.at(-1)?.[0].settings.memoryVectorService;
		expect(patch).not.toHaveProperty("apiKey");
		expect(patch).not.toHaveProperty("hasCredential");
	});

	it("loads proxy settings from the store on mount", async () => {
		const { client } = createTestClient();
		client.settings.get = vi.fn().mockResolvedValue({
			ok: true,
			data: {
				settings: {
					...disabledSettings,
					networkProxy: { mode: "manual", url: "http://127.0.0.1:7890" },
				},
			},
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage } = await openSettings("network");
		await waitForSettings(backstage);
		expect(selectTrigger(backstage, zhCN.settings.proxyMode)).toHaveTextContent(
			zhCN.settings.proxyModes.manual,
		);
		expect(within(backstage).getByPlaceholderText("http://127.0.0.1:7890")).toHaveValue(
			"http://127.0.0.1:7890",
		);
	});

	it("keeps provider choices as drafts until memory configuration is explicitly saved", async () => {
		const { client, settingsSet } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		expect(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.none }),
		).toBeChecked();
		await user.click(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.local }),
		);
		expect(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.local }),
		).toBeChecked();
		expect(settingsSet).not.toHaveBeenCalled();
		expect(client.memory.activateLocalEmbedding).not.toHaveBeenCalled();
		await reopenMemory(backstage, user);
		expect(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.none }),
		).toBeChecked();
	});

	it("saves proxy changes via settings.set", async () => {
		const { client, settingsSet } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings("network");
		await waitForSettings(backstage);
		await user.click(selectTrigger(backstage, zhCN.settings.proxyMode));
		await user.click(await screen.findByRole("option", { name: zhCN.settings.proxyModes.manual }));
		const proxyUrl = within(backstage).getByPlaceholderText("http://127.0.0.1:7890");
		await user.clear(proxyUrl);
		await user.type(proxyUrl, "http://proxy.example.com:8080");
		await user.click(networkSaveButton(backstage));
		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith({
				settings: { networkProxy: { mode: "manual", url: "http://proxy.example.com:8080" } },
			}),
		);
	});

	it("acquires embedding files independently of configuration and proxy saves", async () => {
		const { client, settingsSet } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await user.click(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.local }),
		);
		await user.click(
			within(backstage).getByRole("button", { name: zhCN.settings.downloadAndEnableLocalModel }),
		);
		await waitFor(() =>
			expect(client.memory.localEmbeddingAcquisitionStart).toHaveBeenCalledWith({
				target,
				source: { type: "official" },
			}),
		);
		pushHostEvent(client, "memory.embedding_acquisition_changed", {
			revision: 2,
			phase: "completed",
			operationId: "download-1",
			target,
			downloadedBytes: 4096,
		});
		expect(
			await within(backstage).findByRole("button", { name: zhCN.settings.enableLocalModel }),
		).toBeEnabled();
		expect(settingsSet).not.toHaveBeenCalled();
		expect(client.memory.activateLocalEmbedding).not.toHaveBeenCalled();
		await reopenMemory(backstage, user);
		expect(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.none }),
		).toBeChecked();
	});

	it("shows feedback on successful proxy save", async () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings("network");
		await waitForSettings(backstage);
		await user.click(networkSaveButton(backstage));
		await waitFor(() =>
			expect(within(backstage).getByRole("status")).toHaveTextContent(zhCN.settings.saved),
		);
	});

	it("shows error on failed proxy save", async () => {
		const { client } = createTestClient();
		client.settings.set = vi.fn().mockResolvedValue({
			ok: false,
			error: { kind: "internal", reason: "settings_write_failed" },
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings("network");
		await waitForSettings(backstage);
		await user.click(networkSaveButton(backstage));
		expect(await within(backstage).findByRole("alert")).toBeVisible();
		expect(within(backstage).queryByRole("status")).not.toBeInTheDocument();
		expect(networkSaveButton(backstage)).toBeEnabled();
	});

	it("uses the inline mirror draft for acquisition without persisting memory configuration", async () => {
		const { client, settingsSet } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		const embedding = embeddingSettings(backstage);
		await user.click(
			within(embedding).getByRole("radio", { name: zhCN.settings.vectorProviders.local }),
		);
		await user.click(selectTrigger(embedding, zhCN.settings.downloadMirrorLabel));
		await user.click(
			await screen.findByRole("option", { name: zhCN.settings.downloadSources.custom }),
		);
		const mirror = within(embedding).getByRole("textbox", {
			name: zhCN.settings.downloadMirrorLabel,
		});
		await user.type(mirror, "  https://mirror.example.com/hf  ");
		await user.click(
			within(embedding).getByRole("button", { name: zhCN.settings.downloadAndEnableLocalModel }),
		);
		await waitFor(() =>
			expect(client.memory.localEmbeddingAcquisitionStart).toHaveBeenCalledWith({
				target,
				source: { type: "custom", endpoint: "https://mirror.example.com/hf" },
			}),
		);
		expect(settingsSet).not.toHaveBeenCalled();
		expect(client.memory.activateLocalEmbedding).not.toHaveBeenCalled();
	});

	it("keeps the persisted Host provider until local activation succeeds", async () => {
		const { client } = createTestClient();
		const completion = Promise.withResolvers<void>();
		client.settings.get = vi
			.fn()
			.mockResolvedValue({ ok: true, data: { settings: remoteSettings } });
		client.memory.localEmbeddingInventory = vi.fn().mockResolvedValue({
			ok: true,
			data: { candidates: [{ ...candidate, installed: true }] },
		});
		client.memory.activateLocalEmbedding = vi.fn(async () => {
			await completion.promise;
			client.memory.localEmbeddingInventory = vi.fn().mockResolvedValue({
				ok: true,
				data: { candidates: [{ ...candidate, installed: true }], activeTarget: target },
			});
			return { ok: true as const, data: { settings: localSettings } };
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		expect(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.remote }),
		).toBeChecked();
		await user.click(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.local }),
		);
		await user.click(
			within(backstage).getByRole("button", { name: zhCN.settings.enableLocalModel }),
		);
		await waitFor(() =>
			expect(client.memory.activateLocalEmbedding).toHaveBeenCalledWith({ target }),
		);
		expect(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.local }),
		).toBeDisabled();
		expect(within(backstage).queryByRole("progressbar")).not.toBeInTheDocument();
		await reopenMemory(backstage, user);
		expect(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.remote }),
		).toBeChecked();
		completion.resolve();
		await waitFor(() =>
			expect(
				within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.local }),
			).toBeChecked(),
		);
		expect(
			await within(backstage).findByRole("button", { name: zhCN.settings.localModelEnabled }),
		).toBeDisabled();
	});

	it("shows actual acquisition progress, cancels the operation, and retries", async () => {
		const { client } = createTestClient();
		const progress = {
			revision: 1,
			phase: "downloading" as const,
			operationId: "download-1",
			target,
			downloadedBytes: 1024 * 1024,
			totalBytes: 4 * 1024 * 1024,
		};
		client.memory.localEmbeddingAcquisitionStart = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				data: { ...progress, phase: "preparing", downloadedBytes: 0 },
			})
			.mockResolvedValueOnce({
				ok: true,
				data: { ...progress, revision: 4, operationId: "download-2" },
			});
		client.memory.localEmbeddingAcquisitionCancel = vi.fn().mockResolvedValue({
			ok: true,
			data: { ...progress, revision: 3, phase: "cancelled" },
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await user.click(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.local }),
		);
		const section = embeddingSettings(backstage);
		await user.click(
			within(section).getByRole("button", { name: zhCN.settings.downloadAndEnableLocalModel }),
		);
		await waitFor(() =>
			expect(client.memory.localEmbeddingAcquisitionStart).toHaveBeenCalledOnce(),
		);
		pushHostEvent(client, "memory.embedding_acquisition_changed", { ...progress, revision: 2 });
		await waitFor(() =>
			expect(within(section).getByRole("progressbar")).toHaveAttribute("value", "25"),
		);
		expect(within(section).getByText("1.0 MB / 4.0 MB (25%)")).toBeVisible();
		await user.click(within(section).getByRole("button", { name: zhCN.settings.downloadCancel }));
		expect(client.memory.localEmbeddingAcquisitionCancel).toHaveBeenCalledWith({
			operationId: "download-1",
		});
		await waitFor(() => expect(within(section).queryByRole("progressbar")).not.toBeInTheDocument());
		expect(within(section).getByText(zhCN.settings.downloadCancelled)).toBeVisible();
		await user.click(
			within(section).getByRole("button", { name: zhCN.settings.downloadAndEnableLocalModel }),
		);
		await waitFor(() =>
			expect(client.memory.localEmbeddingAcquisitionStart).toHaveBeenCalledTimes(2),
		);
		expect(client.memory.localEmbeddingAcquisitionStart).toHaveBeenLastCalledWith({
			target,
			source: { type: "official" },
		});
		expect(await within(section).findByRole("progressbar")).toHaveAttribute("value", "25");
		expect(client.memory.activateLocalEmbedding).not.toHaveBeenCalled();
	});

	it("keeps remote preset drafts separate from the Host projection until save resolves", async () => {
		const { client } = createTestClient();
		const completion = Promise.withResolvers<void>();
		client.settings.get = vi
			.fn()
			.mockResolvedValue({ ok: true, data: { settings: remoteSettings } });
		client.settings.capabilitiesGet = vi.fn().mockResolvedValue({
			ok: true,
			data: {
				networkProxyModes: [{ id: "direct" }],
				memoryVectorProviders: [{ id: "remote", onboarding: false }],
				memoryVectorPresets: [{ id: "bge-m3", model: "host-preset-model", dimensions: 777 }],
				localEmbeddingCandidates: [],
			},
		});
		client.settings.set = vi.fn(async () => {
			await completion.promise;
			return {
				ok: true as const,
				data: {
					settings: {
						...remoteSettings,
						memoryVectorService: {
							...remoteSettings.memoryVectorService,
							model: "host-canonical-model",
							dimensions: 778,
						},
					},
				},
			};
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await user.click(selectTrigger(backstage, zhCN.settings.vectorPreset));
		await user.click(
			await screen.findByRole("option", { name: zhCN.settings.vectorPresetLabels["bge-m3"] }),
		);
		expect(within(backstage).getByLabelText(zhCN.settings.vectorModel)).toHaveValue(
			"host-preset-model",
		);
		expect(client.settings.set).not.toHaveBeenCalled();
		await user.click(within(backstage).getByRole("button", { name: zhCN.settings.saveEmbedding }));
		await waitFor(() => expect(client.settings.set).toHaveBeenCalled());
		expect(selectTrigger(backstage, zhCN.settings.vectorPreset)).toBeDisabled();
		await reopenMemory(backstage, user);
		expect(within(backstage).getByLabelText(zhCN.settings.vectorModel)).toHaveValue(
			"current-model",
		);
		expect(within(backstage).getByLabelText(zhCN.settings.vectorDimensions)).toHaveValue(64);
		completion.resolve();
		await waitFor(() =>
			expect(within(backstage).getByLabelText(zhCN.settings.vectorModel)).toHaveValue(
				"host-canonical-model",
			),
		);
		expect(within(backstage).getByLabelText(zhCN.settings.vectorDimensions)).toHaveValue(778);
	});

	it("persists the selected inventory candidate only after Host activation", async () => {
		const { client } = createTestClient();
		const alternateTarget = { kind: "candidate" as const, candidateId: "alternate-model" };
		const alternate = {
			...candidate,
			id: alternateTarget.candidateId,
			name: "Alternate model",
			isDefault: false,
			target: alternateTarget,
			installed: true,
		};
		const candidates = [{ ...candidate, installed: true }, alternate];
		const completion = Promise.withResolvers<void>();
		let savedSettings = localSettings;
		client.settings.get = vi.fn(async () => ({
			ok: true as const,
			data: { settings: savedSettings },
		}));
		client.memory.localEmbeddingInventory = vi
			.fn()
			.mockResolvedValue({ ok: true, data: { candidates, activeTarget: target } });
		client.memory.activateLocalEmbedding = vi.fn(async () => {
			await completion.promise;
			savedSettings = {
				...localSettings,
				memoryVectorService: {
					enabled: true,
					provider: "local",
					localModel: alternateTarget.candidateId,
				},
			};
			client.memory.localEmbeddingInventory = vi
				.fn()
				.mockResolvedValue({ ok: true, data: { candidates, activeTarget: alternateTarget } });
			return {
				ok: true as const,
				data: { settings: savedSettings },
			};
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await user.click(selectTrigger(backstage, zhCN.settings.localModel));
		await user.click(await screen.findByRole("option", { name: alternate.name }));
		expect(selectTrigger(backstage, zhCN.settings.localModel)).toHaveTextContent(alternate.name);
		expect(client.memory.activateLocalEmbedding).not.toHaveBeenCalled();
		await user.click(
			within(backstage).getByRole("button", { name: zhCN.settings.enableLocalModel }),
		);
		await waitFor(() =>
			expect(client.memory.activateLocalEmbedding).toHaveBeenCalledWith({
				target: alternateTarget,
			}),
		);
		await reopenMemory(backstage, user);
		expect(selectTrigger(backstage, zhCN.settings.localModel)).toHaveTextContent(candidate.name);
		completion.resolve();
		await waitFor(() =>
			expect(selectTrigger(backstage, zhCN.settings.localModel)).toHaveTextContent(alternate.name),
		);
		expect(
			await within(backstage).findByRole("button", { name: zhCN.settings.localModelEnabled }),
		).toBeDisabled();
		await reopenMemory(backstage, user);
		expect(selectTrigger(backstage, zhCN.settings.localModel)).toHaveTextContent(alternate.name);
		expect(client.memory.localEmbeddingAcquisitionStart).not.toHaveBeenCalled();
	});
});
