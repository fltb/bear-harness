import { zhCN } from "@bear-harness/i18n/locales";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExternalAgentSettings } from "../src/features/ExternalAgentSettings.js";
import { createCompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { createTestClient } from "./fixtures.js";

function renderSettings(client: ReturnType<typeof createTestClient>["client"]) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const Harness = () => {
		const store = createCompanionStore(client);
		return (
			<DesktopProvider store={store}>
				<ExternalAgentSettings />
			</DesktopProvider>
		);
	};
	render(() => (
		<QueryClientProvider client={queryClient}>
			<Harness />
		</QueryClientProvider>
	));
}

describe("ExternalAgentSettings", () => {
	it("exposes a disabled loading state while discovery is pending", async () => {
		const { client } = createTestClient();
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		client.externalAgent.discoverCodex = vi.fn(async () => {
			await pending;
			return { ok: true as const, data: { candidates: [] } };
		});
		renderSettings(client);
		const loading = await screen.findByRole("button", { name: zhCN.settings.loading });
		expect(loading).toBeDisabled();
		expect(screen.queryByText(zhCN.settings.codexNotFound)).not.toBeInTheDocument();
		release?.();
		expect(await screen.findByText(zhCN.settings.codexNotFound)).toBeInTheDocument();
	});

	it("shows an empty discovery result and can refresh it", async () => {
		const { client } = createTestClient();
		renderSettings(client);
		expect(await screen.findByText(zhCN.settings.codexNotFound)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: zhCN.settings.refreshCodex }));
		await waitFor(() => expect(client.externalAgent.discoverCodex).toHaveBeenCalledTimes(2));
	});

	it("filters missing candidates and connects a usable Codex installation", async () => {
		const { client } = createTestClient();
		client.externalAgent.discoverCodex = vi.fn(async () => ({
			ok: true as const,
			data: {
				candidates: [
					{
						candidatePath: "/missing/codex",
						canonicalPath: null,
						version: null,
						sha256: null,
						status: "not_found" as const,
					},
					{
						candidatePath: "/opt/codex",
						canonicalPath: "/opt/codex",
						status: "usable" as const,
						version: "1.2.3",
						sha256: "a".repeat(64),
					},
				],
			},
		}));
		client.externalAgent.status = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true as const,
				data: {
					pi: { available: true as const, profileId: "pi-default" },
					codex: { available: false as const },
				},
			})
			.mockResolvedValue({
				ok: true as const,
				data: {
					pi: { available: true as const, profileId: "pi-default" },
					codex: {
						available: true as const,
						profileId: "codex-1",
						version: "1.2.3",
						hash: "a".repeat(64),
					},
				},
			});
		renderSettings(client);
		expect(await screen.findByText("/opt/codex")).toBeInTheDocument();
		expect(screen.getByText(zhCN.settings.codexCandidateUsable)).toBeInTheDocument();
		expect(screen.queryByText("/missing/codex")).not.toBeInTheDocument();
		const connect = screen.getByRole("button", { name: zhCN.settings.connectCodex });
		expect(connect).toBeDisabled();
		fireEvent.input(screen.getByLabelText(zhCN.settings.codexLoginDirectory), {
			target: { value: "  /private/codex-home  " },
		});
		expect(connect).toBeEnabled();
		await userEvent.click(connect);
		await waitFor(() =>
			expect(client.externalAgent.connectCodex).toHaveBeenCalledWith({
				canonicalPath: "/opt/codex",
				version: "1.2.3",
				sha256: "a".repeat(64),
				codexHome: "/private/codex-home",
			}),
		);
		expect(await screen.findByText(zhCN.settings.codexConnected)).toBeInTheDocument();
	});

	it("reports discovery failures without hiding retry", async () => {
		const { client } = createTestClient();
		client.externalAgent.discoverCodex = vi.fn(async () => {
			throw "discovery failed";
		});
		renderSettings(client);
		expect(await screen.findByText("discovery failed")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: zhCN.settings.refreshCodex })).toBeEnabled();
	});

	it("preserves an Error message from failed discovery", async () => {
		const { client } = createTestClient();
		client.externalAgent.status = vi.fn(async () => {
			throw new Error("status unavailable");
		});
		renderSettings(client);
		expect(await screen.findByText("status unavailable")).toBeInTheDocument();
	});

	it("renders an already connected agent without setup controls", async () => {
		const { client } = createTestClient();
		client.externalAgent.status = vi.fn(async () => ({
			ok: true as const,
			data: {
				pi: { available: true as const, profileId: "pi-default" },
				codex: { available: true as const, profileId: "codex-1", version: "1", hash: "hash" },
			},
		}));
		renderSettings(client);
		expect(await screen.findByText(zhCN.settings.codexConnected)).toBeInTheDocument();
		expect(screen.queryByLabelText(zhCN.settings.codexLoginDirectory)).not.toBeInTheDocument();
	});

	it("keeps an unusable discovery candidate visible but disabled", async () => {
		const { client } = createTestClient();
		client.externalAgent.discoverCodex = vi.fn(async () => ({
			ok: true as const,
			data: {
				candidates: [
					{
						candidatePath: "/broken/codex",
						canonicalPath: null,
						version: null,
						sha256: null,
						status: "rejected" as const,
					},
				],
			},
		}));
		renderSettings(client);
		expect(await screen.findByText("/broken/codex")).toBeInTheDocument();
		expect(screen.getByText(zhCN.settings.codexUnknownVersion)).toBeInTheDocument();
		expect(screen.getByText(zhCN.settings.codexCandidateRejected)).toBeInTheDocument();
		fireEvent.input(screen.getByLabelText(zhCN.settings.codexLoginDirectory), {
			target: { value: "/private/codex-home" },
		});
		expect(screen.getByRole("button", { name: zhCN.settings.connectCodex })).toBeDisabled();
	});

	it("shows a connection error and restores the connect control", async () => {
		const { client } = createTestClient();
		client.externalAgent.discoverCodex = vi.fn(async () => ({
			ok: true as const,
			data: {
				candidates: [
					{
						candidatePath: "/opt/codex",
						canonicalPath: "/opt/codex",
						version: "1.2.3",
						sha256: "b".repeat(64),
						status: "usable" as const,
					},
				],
			},
		}));
		client.externalAgent.connectCodex = vi.fn(async () => {
			throw new Error("connection rejected");
		});
		renderSettings(client);
		await screen.findByText("/opt/codex");
		fireEvent.input(screen.getByLabelText(zhCN.settings.codexLoginDirectory), {
			target: { value: "/private/codex-home" },
		});
		await userEvent.click(screen.getByRole("button", { name: zhCN.settings.connectCodex }));
		expect(await screen.findByText("connection rejected")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: zhCN.settings.connectCodex })).toBeEnabled();
	});

	it("fails closed if a nominally usable candidate lacks verified metadata", async () => {
		const { client } = createTestClient();
		client.externalAgent.discoverCodex = vi.fn(async () => ({
			ok: true as const,
			data: {
				candidates: [
					{
						candidatePath: "/unverified/codex",
						canonicalPath: null,
						version: "1.2.3",
						sha256: "c".repeat(64),
						status: "usable" as const,
					},
					{
						candidatePath: "/unversioned/codex",
						canonicalPath: "/unversioned/codex",
						version: null,
						sha256: "d".repeat(64),
						status: "usable" as const,
					},
					{
						candidatePath: "/unhashed/codex",
						canonicalPath: "/unhashed/codex",
						version: "1.2.3",
						sha256: null,
						status: "usable" as const,
					},
				],
			},
		}));
		renderSettings(client);
		await screen.findByText("/unverified/codex");
		fireEvent.input(screen.getByLabelText(zhCN.settings.codexLoginDirectory), {
			target: { value: "/private/codex-home" },
		});
		for (const button of screen.getAllByRole("button", { name: zhCN.settings.connectCodex }))
			await userEvent.click(button);
		expect(client.externalAgent.connectCodex).not.toHaveBeenCalled();
	});
});
