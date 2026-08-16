import type { ProductConfig } from "@bear-harness/product-config";
import { RPC } from "@bear-harness/protocol/schema";
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
	const character = (await window.evaluate(async (channel) => {
		const response = (await window.bearDesktop.transport.invoke(channel, {})) as {
			ok?: boolean;
			data?: { character?: unknown };
			error?: { kind?: string; reason?: string };
		};
		if (!response.ok || !response.data?.character) {
			throw new Error(
				`character snapshot unavailable: ${response.error?.kind ?? "unknown"}: ${response.error?.reason ?? "unknown"}`,
			);
		}
		return response.data.character;
	}, RPC.snapshot.get.channel)) as CharacterProjection;

	await expect(window).toHaveTitle(product.productName);
	await expect(window.getByRole("heading", { level: 1 })).toHaveText(
		character.character.scene_title,
	);
	await expect(window.getByText(character.name, { exact: true })).toBeVisible();
	await expect(window.getByText(character.character.subtitle, { exact: true })).toBeVisible();
	await expect(window.getByText(character.character.greeting)).toBeVisible();

	const composer = window.getByPlaceholder(character.character.composer_placeholder);
	await expect(composer).toBeVisible();
	await expect(composer).toBeDisabled();

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
