import type { _electron } from "playwright";
import { expect } from "playwright/test";
import type { ProductConfig } from "../product.config";

export type ElectronApp = Awaited<ReturnType<typeof _electron.launch>>;

/**
 * Shared packaged/source UI assertions. Every mode must show the configured
 * product: native window title, document title, character identity, the
 * greeting, a read-only composer, and a preload surface limited to platform
 * plus the fixed renderer-fault reporter.
 */
export async function assertProductWindow(
	electronApp: ElectronApp,
	product: Readonly<ProductConfig>,
) {
	const window = await electronApp.firstWindow();
	await window.waitForLoadState("domcontentloaded");

	const character = product.defaultCharacter;
	await expect(window).toHaveTitle(product.productName);
	await expect(window.getByRole("heading", { level: 1 })).toHaveText(character.sceneTitle);
	await expect(window.getByText(character.name, { exact: true })).toBeVisible();
	await expect(window.getByText(character.subtitle, { exact: true })).toBeVisible();
	await expect(window.getByText(character.greeting)).toBeVisible();

	const composer = window.getByPlaceholder(`对${character.name}说点什么…`);
	await expect(composer).toBeVisible();
	await expect(composer).toHaveAttribute("readonly", "");

	// Preload exposes only platform + the fixed reporter.
	const bridge = await window.evaluate(() => {
		const keys = Object.keys(window.bearDesktop);
		const diagnosticsKeys = Object.keys(window.bearDesktop.diagnostics);
		return {
			keys,
			diagnosticsKeys,
			platform: window.bearDesktop.platform,
			reporterType: typeof window.bearDesktop.diagnostics.reportRendererFault,
		};
	});
	expect(bridge.keys).toEqual(["platform", "diagnostics"]);
	expect(bridge.diagnosticsKeys).toEqual(["reportRendererFault"]);
	expect(bridge.platform).toMatch(/^(darwin|win32|linux)$/);
	expect(bridge.reporterType).toBe("function");

	return window;
}
