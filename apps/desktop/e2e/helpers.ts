import type { _electron } from "playwright";
import { expect } from "playwright/test";
import type { ProductConfig } from "../product.config";

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
 * `product.config`; character identity and copy are read through the real
 * preload snapshot, never duplicated in the product configuration or test.
 */
export async function assertProductWindow(
	electronApp: ElectronApp,
	product: Readonly<ProductConfig>,
) {
	const window = await electronApp.firstWindow();
	await window.waitForLoadState("domcontentloaded");
	const character = (await window.evaluate(async () => {
		const response = (await window.bearDesktop.companion.snapshot.get()) as {
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
	})) as CharacterProjection;

	await expect(window).toHaveTitle(product.productName);
	await expect(window.getByRole("heading", { level: 1 })).toHaveText(character.character.scene_title);
	await expect(window.getByText(character.name, { exact: true })).toBeVisible();
	await expect(window.getByText(character.character.subtitle, { exact: true })).toBeVisible();
	await expect(window.getByText(character.character.greeting)).toBeVisible();

	const composer = window.getByPlaceholder(character.character.composer_placeholder);
	await expect(composer).toBeVisible();
	await expect(composer).toBeDisabled();

	// Preload exposes platform, diagnostics, and companion facade.
	const bridge = await window.evaluate(() => {
		const keys = Object.keys(window.bearDesktop);
		const diagnosticsKeys = Object.keys(window.bearDesktop.diagnostics);
		const companionKeys = Object.keys(window.bearDesktop.companion);
		return {
			keys,
			diagnosticsKeys,
			companionKeys,
			platform: window.bearDesktop.platform,
			reporterType: typeof window.bearDesktop.diagnostics.reportRendererFault,
		};
	});
	expect(bridge.keys).toEqual(["platform", "diagnostics", "companion"]);
	expect(bridge.diagnosticsKeys).toEqual(["reportRendererFault"]);
	expect(bridge.companionKeys).toContain("snapshot");
	expect(bridge.companionKeys).toContain("conversation");
	expect(bridge.companionKeys).toContain("message");
	expect(bridge.companionKeys).toContain("settings");
	expect(bridge.platform).toMatch(/^(darwin|win32|linux)$/);
	expect(bridge.reporterType).toBe("function");

	return window;
}
