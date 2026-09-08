import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	openSync,
	renameSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Logger } from "@bear-harness/tdai-core";

const MAX_FILE_BYTES = 256 * 1024;
const STAGES: Record<string, true> = {
	core: true,
	"pipeline-factory": true,
	factory: true,
	sqlite: true,
	tcvdb: true,
	"tcvdb-client": true,
	embedding: true,
	"bm25-local": true,
	recall: true,
	capture: true,
	l0: true,
	"l1-dedup": true,
	"l1-extractor": true,
	"l1-reader": true,
	"l1-writer": true,
	extractor: true,
	persona: true,
	trigger: true,
	"standalone-runner": true,
	tdai_memory_search: true,
	tdai_conversation_search: true,
};
const REASONS =
	/\b(memory_search_unavailable|memory_search_failed|memory_search_degraded|memory_recall_failed|memory_recall_timeout|memory_recall_degraded|SQLITE_BUSY|SQLITE_CORRUPT|SQLITE_CANTOPEN|SQLITE_READONLY|SQLITE_IOERR|ENOENT|EACCES|ENOSPC|ETIMEDOUT|ECONNREFUSED)\b/;

/** Character-local, content-free diagnostics. Retains at most two 256 KiB files. */
export function createMemoryDiagnosticsLogger(directory: string): Logger {
	const file = join(directory, "memory.jsonl");
	const previous = join(directory, "memory.previous.jsonl");
	const record = (level: "debug" | "info" | "warn" | "error", message: string): void => {
		// Free-form TDAI messages include prompts, queries, paths, credentials and
		// provider responses. Never persist them, even in character-local logs.
		const prefix = message.slice(0, 512);
		const tag = /^\[memory-tdai\]\s*\[([a-z0-9_-]+)\]/.exec(prefix);
		const stage = tag && Object.hasOwn(STAGES, tag[1]!) ? tag[1]! : "memory";
		const operation = /\bre-?index/i.test(prefix)
			? "reindex"
			: /\bcleanup|clos(?:e|ing)|destroy/i.test(prefix)
				? "cleanup"
				: /\binit(?:ializ\w*)?|warmup/i.test(prefix)
					? "initialize"
					: "operation";
		const outcome = /timed?\s*out|timeout/i.test(prefix)
			? "timeout"
			: /fail|error|unavailable|incomplete/i.test(prefix)
				? "failed"
				: /degrad|fallback|falling back/i.test(prefix)
					? "degraded"
					: /complet|ready|initialized/i.test(prefix)
						? "complete"
						: "observed";
		const reason = REASONS.exec(prefix)?.[1];
		const line = `${JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), level, stage, operation, outcome, ...(reason ? { reason } : {}) })}\n`;
		let fd: number | undefined;
		try {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const flags =
				constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_APPEND |
				constants.O_NOFOLLOW |
				constants.O_NONBLOCK;
			fd = openSync(file, flags, 0o600);
			const stat = fstatSync(fd);
			if (!stat.isFile()) return;
			if (stat.size + Buffer.byteLength(line) > MAX_FILE_BYTES) {
				closeSync(fd);
				fd = undefined;
				renameSync(file, previous);
				fd = openSync(file, flags, 0o600);
			}
			writeSync(fd, line);
		} catch {
			// Diagnostics must not prevent optional recall/capture or leak the
			// original message through a global fallback logger.
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	};
	return {
		debug: (message) => record("debug", message),
		info: (message) => record("info", message),
		warn: (message) => record("warn", message),
		error: (message) => record("error", message),
	};
}
