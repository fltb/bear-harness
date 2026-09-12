import type { Logger } from "@bear-harness/tdai-core";
import type { CharacterTrace } from "../diagnostics/character-trace.js";

/** Preserve upstream levels/text through the single character-local writer. */
export function createMemoryDiagnosticsLogger(trace: CharacterTrace): Logger {
	return {
		debug: (message) => trace.emit("memory.upstream", "debug", {}, {}, { message }),
		info: (message) => trace.emit("memory.upstream", "info", {}, {}, { message }),
		warn: (message) => trace.emit("memory.upstream", "warn", {}, {}, { message }),
		error: (message) => trace.emit("memory.upstream", "error", {}, {}, { message }),
	};
}
