import { describe, expect, it } from "vitest";
import { windowPresentation } from "../src/main/window-presentation.js";

describe("window presentation", () => {
	it("keeps both source and packaged E2E fully in the background on CI", () => {
		expect(windowPresentation({ sourceE2E: true, packagedE2E: false, ci: true })).toBe("hidden");
		expect(windowPresentation({ sourceE2E: false, packagedE2E: true, ci: true })).toBe("hidden");
	});

	it("uses a non-activating window for local E2E and a normal window for the product", () => {
		expect(windowPresentation({ sourceE2E: true, packagedE2E: false, ci: false })).toBe("inactive");
		expect(windowPresentation({ sourceE2E: false, packagedE2E: true, ci: false })).toBe("inactive");
		expect(windowPresentation({ sourceE2E: false, packagedE2E: false, ci: false })).toBe("active");
	});
});
