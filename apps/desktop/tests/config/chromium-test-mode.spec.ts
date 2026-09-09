// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { configureChromiumTestMode } from "../../src/main/chromium-test-mode.js";

describe("configureChromiumTestMode", () => {
	it("disables hardware acceleration before ready for packaged automation", () => {
		const appendSwitch = vi.fn();
		const disableHardwareAcceleration = vi.fn();

		configureChromiumTestMode({ commandLine: { appendSwitch }, disableHardwareAcceleration }, true);

		expect(appendSwitch.mock.calls).toEqual([["use-mock-keychain"], ["disable-gpu"]]);
		expect(disableHardwareAcceleration).toHaveBeenCalledOnce();
	});

	it("does not change Chromium for normal packaged launches", () => {
		const appendSwitch = vi.fn();
		const disableHardwareAcceleration = vi.fn();

		configureChromiumTestMode(
			{ commandLine: { appendSwitch }, disableHardwareAcceleration },
			false,
		);

		expect(appendSwitch).not.toHaveBeenCalled();
		expect(disableHardwareAcceleration).not.toHaveBeenCalled();
	});
});
