import { zhCN } from "@bear-harness/i18n/locales";
import { describe, expect, it } from "vitest";
import { type IpcInvocationError, unwrap } from "../src/lib/ipc.js";

describe("IPC error presentation", () => {
	it.each([
		["not_found", zhCN.errors.notFound],
		["conflict", zhCN.errors.conflict],
		["unavailable", zhCN.errors.unavailable],
		["invalid_request", zhCN.errors.invalidRequest],
		["internal", zhCN.errors.generic],
	])("maps %s to stable localized copy", (kind, message) => {
		expect(() =>
			unwrap({
				ok: false,
				error: { kind, reason: "wire details must not leak" },
			}),
		).toThrow(
			expect.objectContaining({
				name: "IpcInvocationError",
				kind,
				message,
			}) as IpcInvocationError,
		);
	});

	it("returns successful payloads unchanged", () => {
		const payload = { id: "value" };
		expect(unwrap({ ok: true, data: payload })).toBe(payload);
	});
});
