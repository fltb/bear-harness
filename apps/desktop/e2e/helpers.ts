import type { ProductConfig } from "@bear-harness/product-config";
import { RPC, type RpcEndpoint } from "@bear-harness/protocol/schema";
import type { _electron } from "playwright";
import { expect } from "playwright/test";

export type ElectronApp = Awaited<ReturnType<typeof _electron.launch>>;

interface CharacterProjection {
	name: string;
	character: {
		subtitle: string;
		scene_title: string;
		greeting: string;
		composer_placeholder: string;
	};
}

async function invokeData<Endpoint extends RpcEndpoint>(
	window: Awaited<ReturnType<ElectronApp["firstWindow"]>>,
	endpoint: Endpoint,
	params: unknown,
) {
	const envelope = await window.evaluate(
		async ({ channel, params }) => window.bearDesktop.transport.invoke(channel, params),
		{ channel: endpoint.channel, params },
	);
	if (!envelope || typeof envelope !== "object" || !("ok" in envelope) || !envelope.ok) {
		throw new Error(`RPC failed: ${endpoint.channel}`);
	}
	return endpoint.response.parse("data" in envelope ? envelope.data : undefined);
}

export async function provisionReplyModel(window: Awaited<ReturnType<ElectronApp["firstWindow"]>>) {
	const { providers } = await invokeData(window, RPC.provider.list, {});
	const provider = providers.find(
		(candidate) => candidate.authType === "api_key" && candidate.availableModels.length > 0,
	);
	if (!provider) throw new Error("desktop E2E requires an API-key provider with a preset model");
	const model = provider.availableModels[0];
	if (!model) throw new Error("desktop E2E provider has no model");
	await invokeData(window, RPC.provider.setApiKey, {
		providerId: provider.id,
		apiKey: "desktop-e2e-key",
		sessionOnly: true,
	});
	await invokeData(window, RPC.model.enable, {
		providerId: provider.id,
		modelId: model.id,
		label: model.name,
	});
	await invokeData(window, RPC.model.defaultsSetReply, {
		reply: { providerId: provider.id, modelId: model.id },
	});
	const snapshot = await invokeData(window, RPC.snapshot.get, {});
	const steps = snapshot.character?.character.first_meeting.steps ?? [];
	let onboarding = await invokeData(window, RPC.onboarding.get, {});
	while (onboarding.status === "active") {
		const step = steps.find((candidate) => candidate.id === onboarding.currentStepId);
		if (!step)
			throw new Error(`desktop E2E cannot resolve onboarding step ${onboarding.currentStepId}`);
		const answer =
			step.kind === "text"
				? "E2E User"
				: step.kind === "choice"
					? step.choices[0]?.value
					: undefined;
		onboarding = await invokeData(window, RPC.onboarding.submit, {
			stepId: step.id,
			...(answer ? { answer } : {}),
		});
	}
	await window.reload();
}

/**
 * Shared packaged/source UI assertions. Product identity comes from
 * `@bear-harness/product-config`; character identity and copy are read through the real
 * preload snapshot, never duplicated in the product configuration or test.
 */
export async function assertProductWindow(
	electronApp: ElectronApp,
	product: Readonly<ProductConfig>,
) {
	const window = await electronApp.firstWindow();
	await window.waitForLoadState("domcontentloaded");
	const snapshot = await invokeData(window, RPC.snapshot.get, {});
	const character = snapshot.character as CharacterProjection | undefined;
	if (!character) throw new Error("character snapshot unavailable");

	await expect(window).toHaveTitle(product.productName);
	await expect(window.getByRole("heading", { level: 1 })).toHaveText(
		character.character.scene_title,
	);
	await expect(window.getByText(character.name, { exact: true })).toBeVisible();
	await expect(window.getByText(character.character.subtitle, { exact: true })).toBeVisible();
	await expect(window.getByText(character.character.greeting)).toBeVisible();

	const composer = window.getByPlaceholder(character.character.composer_placeholder);
	await expect(composer).toBeVisible();
	await expect(composer).toBeEnabled();

	// Preload exposes only platform, diagnostics, and the schema-neutral transport.
	const bridge = await window.evaluate(() => {
		const keys = Object.keys(window.bearDesktop);
		const diagnosticsKeys = Object.keys(window.bearDesktop.diagnostics);
		const transportKeys = Object.keys(window.bearDesktop.transport);
		return {
			keys,
			diagnosticsKeys,
			transportKeys,
			platform: window.bearDesktop.platform,
			reporterType: typeof window.bearDesktop.diagnostics.reportRendererFault,
		};
	});
	expect(bridge.keys).toEqual(["platform", "diagnostics", "transport"]);
	expect(bridge.diagnosticsKeys).toEqual(["reportRendererFault"]);
	expect(bridge.transportKeys).toEqual(["invoke"]);
	expect(bridge.platform).toMatch(/^(darwin|win32|linux)$/);
	expect(bridge.reporterType).toBe("function");

	return window;
}
