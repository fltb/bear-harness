// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { syncFileForDurability } from "../src/storage/durable-file-sync.js";

describe("durable file sync", () => {
	it("opens files with write access before fsync on Windows", () => {
		const open = vi.fn(() => 42);
		const sync = vi.fn();
		const close = vi.fn();

		syncFileForDurability("C:\\data\\character.yaml", {
			platform: "win32",
			open,
			sync,
			close,
		});

		expect(open).toHaveBeenCalledWith("C:\\data\\character.yaml", "r+");
		expect(sync).toHaveBeenCalledWith(42);
		expect(close).toHaveBeenCalledWith(42);
	});

	it.each(["darwin", "linux"] as const)("keeps read-only fsync on %s", (platform) => {
		const open = vi.fn(() => 17);

		syncFileForDurability("/data/character.yaml", {
			platform,
			open,
			sync: vi.fn(),
			close: vi.fn(),
		});

		expect(open).toHaveBeenCalledWith("/data/character.yaml", "r");
	});
});
