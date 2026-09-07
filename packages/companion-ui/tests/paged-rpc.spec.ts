import { describe, expect, it, vi } from "vitest";
import { listAllCharacters, listAllModels } from "../src/stores/paged-rpc.js";

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });

describe("paged RPC collection", () => {
	it("collects every character page without duplicating rows", async () => {
		const list = vi.fn((request: { cursor?: string }) =>
			request.cursor
				? ok({
						characters: [{ id: "character-b", name: "B", subtitle: "B", active: false }],
					})
				: ok({
						characters: [{ id: "character-a", name: "A", subtitle: "A", active: true }],
						nextCursor: "character-a",
					}),
		);
		const result = await listAllCharacters({ character: { list } } as never);
		expect(result.characters.map((character) => character.id)).toEqual([
			"character-a",
			"character-b",
		]);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("uses the complete model route as the next-page cursor", async () => {
		const list = vi.fn((request: { cursor?: { providerId: string; modelId: string } }) =>
			request.cursor
				? ok({
						models: [
							{
								providerId: "provider-b",
								modelId: "same-id",
								label: "B",
								supportsImages: false,
								createdAt: "2026-01-01",
								enabled: true,
								readiness: "ready" as const,
							},
						],
					})
				: ok({
						models: [
							{
								providerId: "provider-a",
								modelId: "same-id",
								label: "A",
								supportsImages: false,
								createdAt: "2026-01-01",
								enabled: true,
								readiness: "ready" as const,
							},
						],
						nextCursor: { providerId: "provider-a", modelId: "same-id" },
					}),
		);
		const result = await listAllModels({ model: { poolGet: list } } as never);
		expect(result.models.map((model) => model.providerId)).toEqual(["provider-a", "provider-b"]);
		expect(list).toHaveBeenLastCalledWith({
			cursor: { providerId: "provider-a", modelId: "same-id" },
			limit: 100,
		});
	});
});
