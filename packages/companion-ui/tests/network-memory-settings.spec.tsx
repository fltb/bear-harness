import { zhCN } from "@bear-harness/i18n/locales";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT, pushHostEvent } from "./fixtures.js";

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
	// Wait for the selected split settings page to finish loading.
	return waitFor(() => {
		const triggers = within(container).getAllByRole("button");
		const proxyReady = triggers.some((b) => b.getAttribute("aria-label") === "代理模式");
		const memoryReady = within(container).queryByRole("region", {
			name: zhCN.settings.memoryVectorSection,
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

describe("NetworkAndMemorySettings", () => {
	it("renders proxy mode and embedding controls", async () => {
		const { client } = createTestClient();
		client.settings.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					settings: {
						relationshipMemoryEnabled: false,
						networkProxy: { mode: "direct" as const },
						memoryVectorService: {
							enabled: true,
							provider: "local" as const,
							localModel: "test-embedding",
						},
						modelDownloadSource: { type: "official" },
					},
				},
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings("network");
		await waitForSettings(backstage);

		expect(
			within(backstage).getByRole("heading", { name: zhCN.settings.networkSection }),
		).toBeTruthy();
		await user.click(
			within(backstage).getByRole("button", { name: zhCN.settings.memoryVectorSection }),
		);
		const embedding = embeddingSettings(backstage);
		expect(
			within(embedding).getByRole("heading", { name: zhCN.settings.downloadMirrorSection }),
		).toBeTruthy();
		expect(selectTrigger(embedding, zhCN.settings.downloadMirrorLabel)).toHaveTextContent(
			zhCN.settings.downloadSources.official,
		);
		expect(
			within(embedding).getByRole("button", {
				name: zhCN.settings.downloadAndEnableLocalModel,
			}),
		).toHaveAttribute("data-variant", "primary");
		expect(
			within(embedding)
				.getByRole("radio", { name: zhCN.settings.vectorProviders.local })
				.parentElement?.querySelector(".settings-choice-control"),
		).toBeInTheDocument();
	});

	it("shows a stable enabled state instead of offering to download the ready local model again", async () => {
		const { client } = createTestClient();
		client.settings.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					settings: {
						relationshipMemoryEnabled: false,
						networkProxy: { mode: "direct" as const },
						memoryVectorService: {
							enabled: true,
							provider: "local" as const,
							localModel: "test-embedding",
						},
						modelDownloadSource: { type: "official" as const },
					},
				},
			}),
		);
		client.memory.localEmbeddingDownloadStatus = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { status: "completed" as const, downloadedBytes: 313_400_000 },
			}),
		);

		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage } = await openSettings();
		expect(within(embeddingSettings(backstage)).getByRole("status")).toHaveTextContent(
			zhCN.settings.localModelReady,
		);
		expect(
			within(embeddingSettings(backstage)).queryByRole("button", {
				name: zhCN.settings.downloadAndEnableLocalModel,
			}),
		).not.toBeInTheDocument();
	});

	it("offers an activation action when the model is downloaded but the provider is disabled", async () => {
		const { client } = createTestClient();
		client.settings.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					settings: {
						relationshipMemoryEnabled: false,
						networkProxy: { mode: "direct" as const },
						memoryVectorService: { enabled: false, provider: "none" as const },
						modelDownloadSource: { type: "official" as const },
					},
				},
			}),
		);
		client.memory.localEmbeddingDownloadStatus = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { status: "completed" as const, downloadedBytes: 313_400_000 },
			}),
		);

		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		const embedding = embeddingSettings(backstage);
		await user.click(
			within(embedding).getByRole("checkbox", { name: zhCN.settings.memoryVectorEnabled }),
		);
		await user.click(
			within(embedding).getByRole("button", { name: zhCN.settings.enableLocalModel }),
		);

		await waitFor(() =>
			expect(client.memory.configureLocalEmbedding).toHaveBeenCalledWith({
				provider: "local",
				candidateId: "test-embedding",
			}),
		);
	});

	it("renders and applies only the capabilities returned by Host", async () => {
		const { client, settingsSet } = createTestClient();
		client.settings.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					settings: {
						relationshipMemoryEnabled: false,
						networkProxy: { mode: "direct" as const },
						memoryVectorService: {
							enabled: true,
							provider: "remote" as const,
							baseUrl: "https://embedding.example/v1",
							model: "unlisted-model",
							dimensions: 1,
							hasCredential: true,
						},
						modelDownloadSource: { type: "official" },
					},
				},
			}),
		);
		client.settings.capabilitiesGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					networkProxyModes: [{ id: "manual" as const }],
					memoryVectorProviders: [{ id: "remote" as const, onboarding: false }],
					memoryVectorPresets: [
						{
							id: "bge-m3",
							model: "host-only-embedding-model",
							dimensions: 777,
						},
					],
					localEmbeddingCandidates: [
						{
							id: "host-only-local",
							name: "Host-only local model",
							dimensions: 768,
							isDefault: true,
						},
					],
				},
			}),
		);

		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings("network");

		await user.click(selectTrigger(backstage, zhCN.settings.proxyMode));
		await waitFor(() => {
			const listbox = screen.getByRole("listbox", { name: zhCN.settings.proxyMode });
			expect(
				within(listbox)
					.getAllByRole("option")
					.map((option) => option.textContent?.trim()),
			).toEqual([
				zhCN.settings.proxyModes.direct,
				zhCN.settings.proxyModes.auto,
				zhCN.settings.proxyModes.manual,
			]);
		});
		await user.click(screen.getByRole("option", { name: zhCN.settings.proxyModes.manual }));
		await user.click(
			within(backstage).getByRole("button", { name: zhCN.settings.memoryVectorSection }),
		);

		expect(
			within(backstage)
				.getAllByRole("radio")
				.map((radio) => radio.getAttribute("value")),
		).toEqual(["remote"]);
		const apiKeyInput = within(backstage).getByLabelText(zhCN.settings.apiKeyLabel);
		expect(apiKeyInput).toHaveValue("");
		expect(apiKeyInput).toHaveAttribute("placeholder", zhCN.settings.apiKeyStoredPlaceholder);

		await user.click(selectTrigger(backstage, zhCN.settings.vectorPreset));
		const preset = await screen.findByRole("option", {
			name: zhCN.settings.vectorPresetLabels["bge-m3"],
		});
		fireEvent.click(preset);
		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith({
				settings: expect.objectContaining({
					memoryVectorService: expect.objectContaining({
						model: "host-only-embedding-model",
						dimensions: 777,
					}),
				}),
			}),
		);
		const embeddingPatch = settingsSet.mock.calls.at(-1)?.[0].settings.memoryVectorService;
		expect(embeddingPatch).not.toHaveProperty("apiKey");
		expect(embeddingPatch).not.toHaveProperty("hasCredential");
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
		const { backstage } = await openSettings("network");
		await waitForSettings(backstage);

		expect(selectTrigger(backstage, "代理模式").textContent).toContain("手动");
		expect(within(backstage).getByPlaceholderText("http://127.0.0.1:7890")).toBeTruthy();
	});

	it("toggles vector memory enabled and shows provider options", async () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();

		const checkbox = within(backstage).getByRole("checkbox", {
			name: zhCN.settings.memoryVectorEnabled,
		});
		expect(checkbox).not.toBeChecked();

		await user.click(checkbox);
		await waitFor(() => expect(checkbox).toBeChecked());

		expect(
			within(backstage).getByRole("radiogroup", { name: zhCN.settings.vectorProvider }),
		).toBeTruthy();
	});

	it("saves proxy changes via settings.set", async () => {
		const { client, settingsSet } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings("network");
		await waitForSettings(backstage);

		const proxySelect = selectTrigger(backstage, "代理模式");
		await user.click(proxySelect);
		const manualOption = await waitFor(
			() =>
				[...screen.getAllByRole("option")].find(
					(el) => el.textContent?.trim() === zhCN.settings.proxyModes.manual,
				),
			{ timeout: 3000 },
		);
		expect(manualOption).toBeTruthy();
		await user.click(manualOption!);

		const proxyUrlField = within(backstage).getByPlaceholderText("http://127.0.0.1:7890");
		await user.clear(proxyUrlField);
		await user.type(proxyUrlField, "http://proxy.example.com:8080");

		await user.click(networkSaveButton(backstage));

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

	it("updates embedding controls independently of the proxy save", async () => {
		const { client, settingsSet } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await waitForSettings(backstage);

		await user.click(
			within(backstage).getByRole("checkbox", { name: zhCN.settings.memoryVectorEnabled }),
		);

		await user.click(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.local }),
		);
		await user.click(
			within(backstage).getByRole("button", {
				name: zhCN.settings.downloadAndEnableLocalModel,
			}),
		);

		await waitFor(() =>
			expect(client.memory.configureLocalEmbedding).toHaveBeenCalledWith({
				provider: "local",
				candidateId: "test-embedding",
			}),
		);
		expect(
			settingsSet.mock.calls.some(
				([request]) =>
					Object.hasOwn(request.settings, "networkProxy") ||
					(request.settings.memoryVectorService as { provider?: string } | undefined)?.provider ===
						"local",
			),
		).toBe(false);
	});

	it("shows feedback on successful proxy save", async () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings("network");
		await waitForSettings(backstage);

		await user.click(networkSaveButton(backstage));

		await waitFor(() => {
			expect(within(backstage).getByRole("status")).toHaveTextContent(zhCN.settings.saved);
		});
	});

	it("shows error on failed proxy save", async () => {
		const { client } = createTestClient();
		client.settings.set = vi.fn(() =>
			Promise.resolve({
				ok: false as const,
				error: { kind: "internal" as const, reason: "settings_write_failed" },
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings("network");
		await waitForSettings(backstage);

		await user.click(networkSaveButton(backstage));

		await waitFor(() => {
			expect(within(backstage).getAllByRole("alert").length).toBeGreaterThan(0);
		});
	});

	it("keeps the download mirror inside the embedding controls", async () => {
		const { client, settingsSet } = createTestClient();
		client.settings.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					settings: {
						relationshipMemoryEnabled: false,
						networkProxy: { mode: "direct" as const },
						memoryVectorService: {
							enabled: true,
							provider: "local" as const,
							localModel: "test-embedding",
						},
						modelDownloadSource: { type: "official" },
					},
				},
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await waitForSettings(backstage);

		const embedding = embeddingSettings(backstage);
		await user.click(selectTrigger(embedding, zhCN.settings.downloadMirrorLabel));
		await user.click(
			await screen.findByRole("option", { name: zhCN.settings.downloadSources.custom }),
		);
		const mirrorField = within(embedding).getByRole("textbox", {
			name: zhCN.settings.downloadMirrorLabel,
		});
		await user.clear(mirrorField);
		await user.type(mirrorField, "https://mirror.example.com/hf");
		await user.click(
			within(embedding).getByRole("button", {
				name: zhCN.settings.downloadAndEnableLocalModel,
			}),
		);

		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith({
				settings: {
					modelDownloadSource: { type: "custom", endpoint: "https://mirror.example.com/hf" },
				},
			}),
		);
	});

	it("keeps the Host provider selected until local configuration succeeds", async () => {
		const { client } = createTestClient();
		let provider: "remote" | "local" = "remote";
		const completion = Promise.withResolvers<void>();
		client.settings.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					settings: {
						relationshipMemoryEnabled: false,
						networkProxy: { mode: "direct" as const },
						memoryVectorService: {
							enabled: true,
							provider,
							...(provider === "local"
								? { localModel: "test-embedding" }
								: { model: "remote-model", dimensions: 1024 }),
						},
						modelDownloadSource: { type: "official" },
					},
				},
			}),
		);
		client.memory.configureLocalEmbedding = vi.fn(async () => {
			await completion.promise;
			provider = "local";
			return { ok: true as const, data: { ready: true } };
		});

		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await waitForSettings(backstage);
		const remoteRadio = within(backstage).getByRole("radio", {
			name: zhCN.settings.vectorProviders.remote,
		});
		const localRadio = within(backstage).getByRole("radio", {
			name: zhCN.settings.vectorProviders.local,
		});
		expect(remoteRadio).toBeChecked();

		await user.click(localRadio);
		await user.click(
			within(backstage).getByRole("button", {
				name: zhCN.settings.downloadAndEnableLocalModel,
			}),
		);
		await waitFor(() => expect(client.memory.configureLocalEmbedding).toHaveBeenCalled());
		expect(localRadio).toBeChecked();
		expect(localRadio).toBeDisabled();
		expect(within(backstage).getByRole("progressbar")).not.toHaveAttribute("value");

		completion.resolve();
		await waitFor(() => expect(localRadio).toBeChecked());
	});

	it("shows actual download progress, cancels, and allows retry inside embedding settings", async () => {
		const { client } = createTestClient();
		let finish!: () => void;
		client.memory.configureLocalEmbedding = vi.fn(
			() =>
				new Promise((resolve) => {
					finish = () =>
						resolve({
							ok: false,
							error: { kind: "conflict", reason: "embedding_download_cancelled" },
						});
				}),
		);
		client.memory.localEmbeddingDownloadStatus = vi.fn().mockResolvedValue({
			ok: true,
			data: { status: "downloading", downloadedBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 },
		});
		client.memory.cancelLocalEmbeddingDownload = vi.fn().mockImplementation(async () => {
			vi.mocked(client.memory.localEmbeddingDownloadStatus).mockResolvedValue({
				ok: true,
				data: { status: "cancelled", downloadedBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 },
			});
			pushHostEvent(client, "memory.embedding_download_changed", {
				status: "cancelled",
				downloadedBytes: 1024 * 1024,
				totalBytes: 4 * 1024 * 1024,
			});
			finish();
			return { ok: true, data: {} };
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await waitForSettings(backstage);
		await user.click(
			within(backstage).getByRole("checkbox", { name: zhCN.settings.memoryVectorEnabled }),
		);
		await user.click(
			within(backstage).getByRole("radio", { name: zhCN.settings.vectorProviders.local }),
		);
		const section = embeddingSettings(backstage);
		await user.click(
			within(section).getByRole("button", { name: zhCN.settings.downloadAndEnableLocalModel }),
		);
		pushHostEvent(client, "memory.embedding_download_changed", {
			status: "downloading",
			downloadedBytes: 1024 * 1024,
			totalBytes: 4 * 1024 * 1024,
		});
		await waitFor(() =>
			expect(within(section).getByRole("progressbar")).toHaveAttribute("value", "25"),
		);
		expect(within(section).getByText("1.0 MB / 4.0 MB (25%)")).toBeVisible();
		await user.click(within(section).getByRole("button", { name: zhCN.settings.downloadCancel }));
		expect(client.memory.cancelLocalEmbeddingDownload).toHaveBeenCalledOnce();
		await waitFor(() => expect(within(section).queryByRole("progressbar")).not.toBeInTheDocument());
		expect(within(section).getByText(zhCN.settings.downloadCancelled)).toBeVisible();
		expect(
			within(section).getByRole("button", { name: zhCN.settings.downloadAndEnableLocalModel }),
		).toBeEnabled();
	});

	it("keeps the Host preset selected until settings persistence succeeds", async () => {
		const { client } = createTestClient();
		let model = "current-model";
		let dimensions = 64;
		const completion = Promise.withResolvers<void>();
		client.settings.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					settings: {
						relationshipMemoryEnabled: false,
						networkProxy: { mode: "direct" as const },
						memoryVectorService: {
							enabled: true,
							provider: "remote" as const,
							model,
							dimensions,
						},
						modelDownloadSource: { type: "official" },
					},
				},
			}),
		);
		client.settings.capabilitiesGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					networkProxyModes: [{ id: "direct" as const }],
					memoryVectorProviders: [{ id: "remote" as const, onboarding: false }],
					memoryVectorPresets: [{ id: "bge-m3", model: "host-preset-model", dimensions: 777 }],
					localEmbeddingCandidates: [],
				},
			}),
		);
		client.settings.set = vi.fn(async () => {
			await completion.promise;
			model = "host-preset-model";
			dimensions = 777;
			return {
				ok: true as const,
				data: {
					settings: {
						networkProxy: { mode: "direct" as const },
						memoryVectorService: {
							enabled: true,
							provider: "remote" as const,
							model,
							dimensions,
						},
					},
				},
			};
		});

		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage, user } = await openSettings();
		await waitForSettings(backstage);
		const trigger = selectTrigger(backstage, zhCN.settings.vectorPreset);
		expect(trigger).not.toHaveTextContent(zhCN.settings.vectorPresetLabels["bge-m3"]);

		await user.click(trigger);
		await user.click(
			await screen.findByRole("option", { name: zhCN.settings.vectorPresetLabels["bge-m3"] }),
		);
		await waitFor(() => expect(client.settings.set).toHaveBeenCalled());
		expect(trigger).not.toHaveTextContent(zhCN.settings.vectorPresetLabels["bge-m3"]);
		expect(trigger).toBeDisabled();

		completion.resolve();
		await waitFor(() =>
			expect(trigger).toHaveTextContent(zhCN.settings.vectorPresetLabels["bge-m3"]),
		);
	});
});
