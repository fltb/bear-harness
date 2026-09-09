import { describe, expect, it } from "vitest";
import { windowPresentation } from "../../src/main/window-presentation.js";

describe("window presentation", () => {
	it("keeps source and packaged automation rendered without taking focus", () => {
		expect(windowPresentation({ sourceE2E: true, packagedE2E: false })).toBe("inactive");
		expect(windowPresentation({ sourceE2E: false, packagedE2E: true })).toBe("inactive");
	});

	it("uses a normal active window for the product", () => {
		expect(windowPresentation({ sourceE2E: false, packagedE2E: false })).toBe("active");
	});
});
