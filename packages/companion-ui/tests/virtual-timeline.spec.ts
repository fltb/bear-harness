import { describe, expect, it } from "vitest";
import { reconcileVirtualTimelineMeasurements } from "../src/lib/virtual-timeline.js";

describe("virtual timeline reconciliation", () => {
	it("projects stale measurement keys onto current item identities without blank rows", () => {
		const current = [{ id: "new-a" }, { id: "new-b" }];
		const measured = [
			{ key: "old-a", index: 0 },
			{ key: "new-b", index: 1 },
		];

		expect([...reconcileVirtualTimelineMeasurements(measured, current).keys()]).toEqual([
			"new-a",
			"new-b",
		]);
		expect(reconcileVirtualTimelineMeasurements(measured, current).get("new-a")).toBe(measured[0]);
	});
});
