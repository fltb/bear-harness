import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	options: vi.fn(),
	show: vi.fn(),
	showInactive: vi.fn(),
	callbacks: new Map<string, () => void>(),
}));

vi.mock("electron", () => ({
	BrowserWindow: class {
		constructor(options: unknown) {
			mocks.options(options);
		}
		webContents = {
			session: { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() },
			setWindowOpenHandler: vi.fn(),
			on: vi.fn(),
			once: (event: string, callback: () => void) => mocks.callbacks.set(event, callback),
		};
		show = mocks.show;
		showInactive = mocks.showInactive;
		once = vi.fn();
		loadURL = vi.fn();
	},
}));

import { chooseRecoveryAction } from "../../src/main/recovery-window.js";
import { windowPresentation } from "../../src/main/window-presentation.js";

describe("recovery window focus", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.callbacks.clear();
	});
	it.each([
		{ sourceE2E: true, packagedE2E: false },
		{ sourceE2E: false, packagedE2E: true },
	])("does not activate during automation: %j", (mode) => {
		void chooseRecoveryAction(
			"Bear",
			{ reason: "test", actions: ["exit"] },
			windowPresentation(mode),
		);
		mocks.callbacks.get("did-finish-load")?.();
		expect(mocks.options).toHaveBeenCalledWith(
			expect.objectContaining({ show: false, focusable: false }),
		);
		expect(mocks.showInactive).toHaveBeenCalledOnce();
		expect(mocks.show).not.toHaveBeenCalled();
	});
	it("preserves normal recovery focus outside automation", () => {
		void chooseRecoveryAction("Bear", { reason: "test", actions: ["exit"] });
		mocks.callbacks.get("did-finish-load")?.();
		expect(mocks.options).toHaveBeenCalledWith(
			expect.objectContaining({ show: false, focusable: true }),
		);
		expect(mocks.show).toHaveBeenCalledOnce();
		expect(mocks.showInactive).not.toHaveBeenCalled();
	});
});
