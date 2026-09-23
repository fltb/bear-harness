import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { RunnerSettings } from "../src/features/RunnerSettings.js";
import { createCompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { createTestClient } from "./fixtures.js";

function renderSettings(client: ReturnType<typeof createTestClient>["client"]) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const Harness = () => {
		const store = createCompanionStore(client, "jizhou");
		return (
			<DesktopProvider store={store}>
				<RunnerSettings />
			</DesktopProvider>
		);
	};
	render(() => (
		<QueryClientProvider client={queryClient}>
			<Harness />
		</QueryClientProvider>
	));
}
it("saves a custom runner's selection guidance and ACP command through the shared settings API", async () => {
	const { client } = createTestClient();
	client.externalAgent.save = vi.fn().mockResolvedValue({ ok: true, data: {} });
	renderSettings(client);
	await userEvent.click(screen.getByRole("button", { name: zhCN.settings.runnerAdd }));
	await userEvent.type(screen.getByLabelText(zhCN.settings.runnerName), "Research");
	await userEvent.type(screen.getByLabelText(zhCN.settings.runnerDescription), "Research worker");
	await userEvent.type(screen.getByLabelText(zhCN.settings.runnerUseWhen), "For research");
	await userEvent.type(
		screen.getByLabelText(zhCN.settings.runnerCommand),
		"/usr/local/bin/research-acp",
	);
	await userEvent.click(screen.getByRole("button", { name: zhCN.settings.runnerSave }));
	await waitFor(() =>
		expect(client.externalAgent.save).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Research",
				description: "Research worker",
				useWhen: "For research",
				enabled: true,
				configuration: expect.objectContaining({
					command: "/usr/local/bin/research-acp",
					args: [],
					environment: [],
				}),
			}),
		),
	);
	expect(screen.queryByLabelText(zhCN.settings.runnerCommand)).not.toBeInTheDocument();
});
it("shows actual negotiated capabilities and keeps Pi enabled when editing the default", async () => {
	const { client } = createTestClient();
	client.externalAgent.list = vi.fn().mockResolvedValue({
		ok: true,
		data: {
			items: [
				{
					runnerId: "pi-default",
					kind: "pi",
					name: "Pi Worker",
					description: "Built-in",
					useWhen: "Default",
					limitations: "",
					enabled: true,
					configured: true,
				},
			],
		},
	});
	client.externalAgent.test = vi.fn().mockResolvedValue({
		ok: true,
		data: {
			protocolVersion: 1,
			name: "Pi",
			version: "1",
			authenticated: true,
			authMethods: [],
			capabilities: { loadSession: false, resume: true, steer: false },
		},
	});
	renderSettings(client);
	await screen.findByText("Pi Worker");
	await userEvent.click(screen.getByRole("button", { name: zhCN.settings.runnerTest }));
	expect(await screen.findByRole("status")).toHaveTextContent("Pi 1");
	expect(screen.getByRole("status")).toHaveTextContent(zhCN.settings.runnerUnsupported);
	await userEvent.click(screen.getByRole("button", { name: zhCN.settings.runnerEdit }));
	expect(screen.getByRole("checkbox", { name: zhCN.settings.runnerEnabled })).toBeDisabled();
	expect(screen.queryByLabelText(zhCN.settings.runnerCommand)).not.toBeInTheDocument();
});
