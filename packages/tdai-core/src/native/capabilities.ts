/**
 * Host-native capability boundary.
 *
 * Tdai Core remains usable in a plain Node host when an optional binary is
 * absent. Desktop packaging keeps the modules below outside ASAR; this module
 * keeps their loading policy and fallbacks in one place.
 */

import { createRequire } from "node:module";

export type NativeCapabilityId = "node-sqlite" | "sqlite-vec" | "jieba" | "llama";

export type NativeCapabilityStatus = {
	id: NativeCapabilityId;
	available: boolean | null;
	reason?: string;
};

export type LlamaGpuBackend = "auto" | "metal" | "cuda" | "vulkan" | false;

export type LlamaModule = {
	getLlama: (options: {
		logLevel: number;
		gpu: LlamaGpuBackend;
		build: "never";
		skipDownload: true;
		usePrebuiltBinaries: true;
		progressLogs: false;
	}) => Promise<unknown>;
	resolveModelFile: (
		model: string,
		options?: {
			directory?: string;
			cli?: boolean;
			endpoints?: { huggingFace?: string };
			signal?: AbortSignal;
			onProgress?: (progress: { downloadedSize: number; totalSize: number }) => void;
			deleteTempFileOnCancel?: boolean;
		},
	) => Promise<string>;
	LlamaLogLevel: { readonly error: number };
};

export interface JiebaInstance {
	cutForSearch(text: string, hmm: boolean): string[];
}

type SqliteVecModule = { load(database: unknown): void };

const require = createRequire(import.meta.url);

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Lazy, failure-tolerant access to native dependencies. Calling code decides
 * whether an unavailable capability is fatal or should use its own fallback.
 */
export class NativeCapabilities {
	private readonly statuses = new Map<NativeCapabilityId, NativeCapabilityStatus>();
	private jieba: JiebaInstance | null | undefined;
	private llamaModule: Promise<LlamaModule> | undefined;

	status(id: NativeCapabilityId): NativeCapabilityStatus {
		return this.statuses.get(id) ?? { id, available: null };
	}

	statusesSnapshot(): NativeCapabilityStatus[] {
		return (["node-sqlite", "sqlite-vec", "jieba", "llama"] as const).map((id) => this.status(id));
	}

	requireNodeSqlite(): typeof import("node:sqlite") {
		try {
			const sqlite = require("node:sqlite") as typeof import("node:sqlite");
			this.record("node-sqlite", true);
			return sqlite;
		} catch (error) {
			this.record("node-sqlite", false, error);
			throw error;
		}
	}

	loadSqliteVec(): SqliteVecModule {
		try {
			const sqliteVec = require("sqlite-vec") as SqliteVecModule;
			this.record("sqlite-vec", true);
			return sqliteVec;
		} catch (error) {
			this.record("sqlite-vec", false, error);
			throw error;
		}
	}

	getJieba(): JiebaInstance | null {
		if (this.jieba !== undefined) return this.jieba;
		try {
			const { Jieba } = require("@node-rs/jieba") as {
				Jieba: { withDict(dictionary: unknown): JiebaInstance };
			};
			const { dict } = require("@node-rs/jieba/dict") as { dict: unknown };
			this.jieba = Jieba.withDict(dict);
			this.record("jieba", true);
		} catch (error) {
			this.jieba = null;
			this.record("jieba", false, error);
		}
		return this.jieba;
	}

	/** @internal Test-only hook for deterministic FTS fallback coverage. */
	setJiebaForTest(instance: JiebaInstance | null | undefined): void {
		this.jieba = instance;
		if (instance === undefined) this.statuses.delete("jieba");
		else this.record("jieba", instance !== null);
	}

	importLlama(): Promise<LlamaModule> {
		if (!this.llamaModule) {
			this.llamaModule = import("node-llama-cpp")
				.then((module) => {
					this.record("llama", true);
					return module as LlamaModule;
				})
				.catch((error: unknown) => {
					this.record("llama", false, error);
					this.llamaModule = undefined;
					throw error;
				});
		}
		return this.llamaModule;
	}

	private record(id: NativeCapabilityId, available: boolean, error?: unknown): void {
		this.statuses.set(id, {
			id,
			available,
			...(error ? { reason: errorMessage(error) } : {}),
		});
	}
}

/** Shared default for Node and Electron hosts. */
export const nativeCapabilities = new NativeCapabilities();
