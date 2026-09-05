import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
	LocalEmbeddingAcquisitionCancelRequest,
	LocalEmbeddingAcquisitionCancelResponse,
	LocalEmbeddingAcquisitionStartRequest,
	LocalEmbeddingAcquisitionStartResponse,
	LocalEmbeddingAcquisitionState,
	LocalEmbeddingInventoryResponse,
	LocalEmbeddingTarget,
	ModelDownloadSource,
} from "@bear-harness/protocol";
import { LocalEmbeddingAcquisitionState as LocalEmbeddingAcquisitionStateSchema } from "@bear-harness/protocol/schema";
import {
	HOST_SETTINGS_CAPABILITIES,
	type HostLocalEmbeddingCandidate,
} from "../settings/capabilities.js";
import type { RuntimeLayout } from "../storage/layout.js";
import { validateLocalEmbedding } from "./tencentdb-runtime.js";

const ACTIVE_PHASES: Partial<Record<LocalEmbeddingAcquisitionState["phase"], true>> = {
	preparing: true,
	downloading: true,
	validating: true,
};
const STATE_FILENAME = "acquisition-state.json";
const CANDIDATE_DIRECTORY = "candidates";
const UNKNOWN_TOTAL_PROGRESS_STEP = 1024 * 1024;

type AcquisitionErrorCode = Extract<
	LocalEmbeddingAcquisitionState,
	{ errorCode: string }
>["errorCode"];
type OperationState = Exclude<LocalEmbeddingAcquisitionState, { phase: "idle" }>;
type ActiveState = Extract<OperationState, { phase: "preparing" | "downloading" | "validating" }>;
type RuntimeFailureCode = Exclude<AcquisitionErrorCode, "local_embedding_interrupted">;
type TransitionPatch =
	| {
			readonly phase: "preparing" | "downloading" | "validating" | "completed" | "cancelled";
			readonly downloadedBytes?: number;
			readonly totalBytes?: number;
	  }
	| {
			readonly phase: "failed";
			readonly errorCode: RuntimeFailureCode;
			readonly downloadedBytes?: number;
			readonly totalBytes?: number;
	  }
	| {
			readonly phase: "interrupted";
			readonly errorCode: "local_embedding_interrupted";
			readonly downloadedBytes?: number;
			readonly totalBytes?: number;
	  };

export interface LocalEmbeddingValidationRequest {
	readonly modelPath: string;
	readonly dimensions: number;
	readonly signal: AbortSignal;
}

export interface ResolvedLocalEmbeddingTarget {
	readonly target: LocalEmbeddingTarget;
	readonly modelPath: string;
	readonly dimensions: number;
}

export interface LocalEmbeddingAcquisitionOptions {
	readonly layout?: Pick<RuntimeLayout, "systemEmbeddingModels">;
	readonly cacheRoot?: string;
	readonly candidates?: readonly HostLocalEmbeddingCandidate[];
	readonly fetch?: (
		input: string,
		init: { readonly signal: AbortSignal; readonly redirect: "follow" },
	) => Promise<Response>;
	readonly validate?: (request: LocalEmbeddingValidationRequest) => Promise<void>;
	readonly onStateChange?: (state: LocalEmbeddingAcquisitionState) => void;
	readonly createOperationId?: () => string;
}

class AcquisitionFailure extends Error {
	constructor(readonly code: RuntimeFailureCode) {
		super(code);
	}
}

function copyTarget(target: LocalEmbeddingTarget): LocalEmbeddingTarget {
	return target.kind === "candidate"
		? { kind: "candidate", candidateId: target.candidateId }
		: {
				kind: "custom",
				customPath: target.customPath,
				dimensions: target.dimensions,
			};
}

function copyState(state: LocalEmbeddingAcquisitionState): LocalEmbeddingAcquisitionState {
	if (state.phase === "idle") return { ...state };
	return {
		...state,
		target: copyTarget(state.target),
	};
}

function isOperationState(state: LocalEmbeddingAcquisitionState): state is OperationState {
	return state.phase !== "idle";
}

function isActiveState(state: LocalEmbeddingAcquisitionState): state is ActiveState {
	return ACTIVE_PHASES[state.phase] === true;
}

function validatedEndpoint(source: ModelDownloadSource): URL {
	const raw =
		source.type === "official"
			? "https://huggingface.co"
			: source.type === "hf-mirror"
				? "https://hf-mirror.com"
				: source.endpoint;
	let endpoint: URL;
	try {
		endpoint = new URL(raw);
	} catch {
		throw new AcquisitionFailure("local_embedding_target_invalid");
	}
	if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
		throw new AcquisitionFailure("local_embedding_target_invalid");
	}
	return endpoint;
}

function sourceFingerprint(source: ModelDownloadSource, endpoint: URL): string {
	const identity =
		source.type === "custom"
			? JSON.stringify({ type: source.type, endpoint: endpoint.href })
			: JSON.stringify({ type: source.type });
	return createHash("sha256").update(identity).digest("hex");
}

function candidateDownloadUrl(modelPath: string, endpoint: URL): URL {
	if (!modelPath.startsWith("hf:")) {
		throw new AcquisitionFailure("local_embedding_target_invalid");
	}
	const segments = modelPath.slice(3).split("/");
	if (segments.length < 3 || segments.some((segment) => !segment)) {
		throw new AcquisitionFailure("local_embedding_target_invalid");
	}
	const [owner, repository, ...fileSegments] = segments;
	if (!owner || !repository || fileSegments.length === 0) {
		throw new AcquisitionFailure("local_embedding_target_invalid");
	}
	const encoded = [owner, repository, "resolve", "main", ...fileSegments]
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	const result = new URL(endpoint.href);
	result.pathname = `${result.pathname.replace(/\/$/, "")}/${encoded}`;
	return result;
}

function responseEndpointIsSafe(response: Response): boolean {
	if (!response.url) return true;
	try {
		const url = new URL(response.url);
		return url.protocol === "https:" && !url.username && !url.password;
	} catch {
		return false;
	}
}

function parseContentLength(response: Response): number | undefined {
	const raw = response.headers.get("content-length");
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isMissingFile(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	return error.code === "ENOENT";
}

/**
 * Installation-scoped model acquisition. It deliberately has no settings or
 * credential dependency: completion only means that bytes were acquired and
 * validated, never that a memory provider was activated.
 */
export class LocalEmbeddingAcquisitionService {
	readonly cacheRoot: string;
	readonly statePath: string;

	private readonly candidates: readonly HostLocalEmbeddingCandidate[];
	private readonly fetchModel: NonNullable<LocalEmbeddingAcquisitionOptions["fetch"]>;
	private readonly validateModel: NonNullable<LocalEmbeddingAcquisitionOptions["validate"]>;
	private readonly onStateChange?: LocalEmbeddingAcquisitionOptions["onStateChange"];
	private readonly createOperationId: () => string;
	private state: LocalEmbeddingAcquisitionState = {
		revision: 0,
		phase: "idle",
		downloadedBytes: 0,
	};
	private ready: Promise<void> | undefined;
	private mutationTail: Promise<void> = Promise.resolve();
	private controller: AbortController | undefined;
	private running: Promise<void> | undefined;
	private closed = false;

	constructor(options: LocalEmbeddingAcquisitionOptions) {
		const cacheRoot = options.cacheRoot ?? options.layout?.systemEmbeddingModels;
		if (!cacheRoot) throw new Error("local embedding acquisition cacheRoot is required");
		this.cacheRoot = cacheRoot;
		this.statePath = join(cacheRoot, STATE_FILENAME);
		this.candidates = options.candidates ?? HOST_SETTINGS_CAPABILITIES.localEmbeddingCandidates;
		this.fetchModel = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.validateModel =
			options.validate ??
			(async ({ modelPath, dimensions, signal }) => {
				await validateLocalEmbedding({
					modelPath,
					dimensions,
					download: false,
					signal,
				});
			});
		this.onStateChange = options.onStateChange;
		this.createOperationId = options.createOperationId ?? randomUUID;
	}

	async status(): Promise<LocalEmbeddingAcquisitionState> {
		await this.ensureReady();
		return copyState(this.state);
	}

	async inventory(activeTarget?: LocalEmbeddingTarget): Promise<LocalEmbeddingInventoryResponse> {
		await this.ensureReady();
		const candidates = await Promise.all(
			this.candidates.map(async (candidate) => ({
				id: candidate.id,
				name: candidate.name,
				dimensions: candidate.dimensions,
				isDefault: candidate.isDefault,
				target: { kind: "candidate" as const, candidateId: candidate.id },
				installed: await this.isFile(this.candidateFinalPath(candidate)),
			})),
		);
		return {
			candidates,
			...(activeTarget ? { activeTarget: copyTarget(activeTarget) } : {}),
		};
	}

	start(
		request: LocalEmbeddingAcquisitionStartRequest,
	): Promise<LocalEmbeddingAcquisitionStartResponse> {
		return this.sequence(() => this.startExclusive(request));
	}

	private async startExclusive(
		request: LocalEmbeddingAcquisitionStartRequest,
	): Promise<LocalEmbeddingAcquisitionStartResponse> {
		await this.ensureReady();
		if (this.closed) throw { kind: "conflict", reason: "local_embedding_acquisition_closed" };
		if (isActiveState(this.state)) {
			throw { kind: "conflict", reason: "local_embedding_acquisition_in_progress" };
		}
		const resolved = this.resolveTarget(request.target);
		let endpoint: URL;
		try {
			endpoint = validatedEndpoint(request.source);
		} catch {
			throw { kind: "invalid_request", reason: "invalid_model_download_endpoint" };
		}
		const operationId = this.createOperationId();
		if (!operationId || operationId.length > 64) {
			throw new Error("local embedding operation id must contain 1-64 characters");
		}
		const controller = new AbortController();
		this.controller = controller;
		await this.replaceState({
			revision: this.state.revision + 1,
			operationId,
			target: copyTarget(request.target),
			sourceFingerprint: sourceFingerprint(request.source, endpoint),
			phase: "preparing",
			downloadedBytes: 0,
		});

		const work = this.acquire(resolved, endpoint, operationId, controller.signal);
		this.running = work;
		void work.then(
			() => {
				if (this.running === work) this.running = undefined;
				if (this.controller === controller) this.controller = undefined;
			},
			() => {
				if (this.running === work) this.running = undefined;
				if (this.controller === controller) this.controller = undefined;
			},
		);
		return copyState(this.state);
	}

	cancel(
		request: LocalEmbeddingAcquisitionCancelRequest,
	): Promise<LocalEmbeddingAcquisitionCancelResponse> {
		return this.sequence(() => this.cancelExclusive(request));
	}

	private async cancelExclusive(
		request: LocalEmbeddingAcquisitionCancelRequest,
	): Promise<LocalEmbeddingAcquisitionCancelResponse> {
		await this.ensureReady();
		if (!isOperationState(this.state) || request.operationId !== this.state.operationId) {
			throw { kind: "conflict", reason: "local_embedding_acquisition_stale_operation" };
		}
		if (!isActiveState(this.state) || !this.controller || !this.running) {
			throw { kind: "conflict", reason: "local_embedding_acquisition_not_active" };
		}
		this.controller.abort(new Error("local embedding acquisition cancelled"));
		await this.running.catch(() => undefined);
		return copyState(this.state);
	}

	async resolveInstalledTarget(
		target: LocalEmbeddingTarget,
	): Promise<ResolvedLocalEmbeddingTarget> {
		await this.ensureReady();
		const resolved = this.resolveTarget(target);
		if (!(await this.isFile(resolved.modelPath))) {
			throw { kind: "conflict", reason: "local_embedding_target_not_installed" };
		}
		return resolved;
	}

	resolveCandidatePath(candidateId: string): string {
		return this.resolveTarget({ kind: "candidate", candidateId }).modelPath;
	}

	async resolveInstalledPath(target: LocalEmbeddingTarget): Promise<string> {
		return (await this.resolveInstalledTarget(target)).modelPath;
	}

	close(): Promise<void> {
		return this.sequence(() => this.closeExclusive());
	}

	private async closeExclusive(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.ready;
		this.controller?.abort(new Error("local embedding acquisition service closed"));
		await this.running?.catch(() => undefined);
	}

	private async sequence<T>(action: () => Promise<T>): Promise<T> {
		const previous = this.mutationTail;
		const gate = Promise.withResolvers<void>();
		this.mutationTail = previous.catch(() => undefined).then(() => gate.promise);
		await previous.catch(() => undefined);
		try {
			return await action();
		} finally {
			gate.resolve();
		}
	}

	private ensureReady(): Promise<void> {
		this.ready ??= this.initialize();
		return this.ready;
	}

	private async initialize(): Promise<void> {
		await mkdir(this.cacheRoot, { recursive: true });
		try {
			const stored = LocalEmbeddingAcquisitionStateSchema.parse(
				JSON.parse(await readFile(this.statePath, "utf8")),
			);
			this.state = copyState(stored);
			if (isActiveState(stored)) {
				await this.transition(stored.operationId, {
					phase: "interrupted",
					errorCode: "local_embedding_interrupted",
				});
			}
		} catch (error) {
			if (!isMissingFile(error)) throw error;
			await this.persist(this.state);
		}
	}

	private resolveTarget(target: LocalEmbeddingTarget): ResolvedLocalEmbeddingTarget {
		if (target.kind === "custom") {
			return {
				target: copyTarget(target),
				modelPath: target.customPath,
				dimensions: target.dimensions,
			};
		}
		const candidate = this.candidates.find((item) => item.id === target.candidateId);
		if (!candidate) {
			throw { kind: "invalid_request", reason: "local_embedding_candidate_not_found" };
		}
		return {
			target: copyTarget(target),
			modelPath: this.candidateFinalPath(candidate),
			dimensions: candidate.dimensions,
		};
	}

	private candidateFinalPath(candidate: HostLocalEmbeddingCandidate): string {
		const name = basename(candidate.modelPath);
		if (!name || name === "." || name === "..") {
			throw new AcquisitionFailure("local_embedding_target_invalid");
		}
		const identity = createHash("sha256").update(candidate.id).digest("hex").slice(0, 20);
		return join(this.cacheRoot, CANDIDATE_DIRECTORY, identity, name);
	}

	private async acquire(
		resolved: ResolvedLocalEmbeddingTarget,
		endpoint: URL,
		operationId: string,
		signal: AbortSignal,
	): Promise<void> {
		let temporaryPath: string | undefined;
		try {
			let validationPath = resolved.modelPath;
			if (resolved.target.kind === "candidate") {
				const candidateId = resolved.target.candidateId;
				const exactCandidate = this.candidates.find((item) => item.id === candidateId);
				if (!exactCandidate) {
					throw new AcquisitionFailure("local_embedding_target_invalid");
				}
				const directory = dirname(resolved.modelPath);
				await mkdir(directory, { recursive: true });
				temporaryPath = join(directory, `.tmp-${operationId}-${basename(resolved.modelPath)}`);
				await this.download(
					candidateDownloadUrl(exactCandidate.modelPath, endpoint),
					temporaryPath,
					operationId,
					signal,
				);
				validationPath = temporaryPath;
			} else if (!(await this.isFile(resolved.modelPath))) {
				throw new AcquisitionFailure("local_embedding_target_invalid");
			}

			signal.throwIfAborted();
			await this.transition(operationId, {
				phase: "validating",
			});
			try {
				await this.validateModel({
					modelPath: validationPath,
					dimensions: resolved.dimensions,
					signal,
				});
			} catch (error) {
				if (signal.aborted) throw error;
				throw new AcquisitionFailure("local_embedding_validation_failed");
			}
			signal.throwIfAborted();

			if (temporaryPath) {
				try {
					await rename(temporaryPath, resolved.modelPath);
					temporaryPath = undefined;
				} catch {
					throw new AcquisitionFailure("local_embedding_io_failed");
				}
			}
			await this.transition(operationId, {
				phase: "completed",
			});
		} catch (error) {
			if (signal.aborted) {
				await this.transition(operationId, { phase: "cancelled" });
			} else {
				const errorCode =
					error instanceof AcquisitionFailure ? error.code : "local_embedding_io_failed";
				await this.transition(operationId, { phase: "failed", errorCode });
			}
		} finally {
			if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
	}

	private async download(
		url: URL,
		temporaryPath: string,
		operationId: string,
		signal: AbortSignal,
	): Promise<void> {
		let response: Response;
		try {
			response = await this.fetchModel(url.href, { signal, redirect: "follow" });
		} catch (error) {
			if (signal.aborted) throw error;
			throw new AcquisitionFailure("local_embedding_download_failed");
		}
		if (!response.ok || !response.body || !responseEndpointIsSafe(response)) {
			throw new AcquisitionFailure("local_embedding_download_failed");
		}
		const totalBytes = parseContentLength(response);
		await this.transition(operationId, {
			phase: "downloading",
			downloadedBytes: 0,
			...(totalBytes === undefined ? { totalBytes: undefined } : { totalBytes }),
		});

		let handle: FileHandle | undefined;
		try {
			handle = await open(temporaryPath, "wx");
			const reader = response.body.getReader();
			let downloadedBytes = 0;
			try {
				while (true) {
					signal.throwIfAborted();
					const chunk = await reader.read();
					if (chunk.done) break;
					await handle.writeFile(chunk.value);
					downloadedBytes += chunk.value.byteLength;
					if (this.progressIsMeaningful(downloadedBytes, totalBytes)) {
						await this.transition(operationId, {
							phase: "downloading",
							downloadedBytes,
						});
					}
				}
			} finally {
				if (signal.aborted) await reader.cancel(signal.reason).catch(() => undefined);
				reader.releaseLock();
			}
			if (totalBytes !== undefined && downloadedBytes !== totalBytes) {
				throw new AcquisitionFailure("local_embedding_download_failed");
			}
			if (this.state.downloadedBytes !== downloadedBytes) {
				await this.transition(operationId, {
					phase: "downloading",
					downloadedBytes,
				});
			}
			await handle.sync();
		} catch (error) {
			if (signal.aborted || error instanceof AcquisitionFailure) throw error;
			throw new AcquisitionFailure("local_embedding_io_failed");
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	private progressIsMeaningful(downloadedBytes: number, totalBytes: number | undefined): boolean {
		const previous = this.state.downloadedBytes;
		if (totalBytes !== undefined && totalBytes > 0) {
			return (
				downloadedBytes === totalBytes ||
				Math.floor((downloadedBytes * 100) / totalBytes) > Math.floor((previous * 100) / totalBytes)
			);
		}
		return (
			Math.floor(downloadedBytes / UNKNOWN_TOTAL_PROGRESS_STEP) >
			Math.floor(previous / UNKNOWN_TOTAL_PROGRESS_STEP)
		);
	}

	private async transition(operationId: string, patch: TransitionPatch): Promise<void> {
		const current = this.state;
		if (!isOperationState(current) || current.operationId !== operationId) return;
		const downloadedBytes = patch.downloadedBytes ?? current.downloadedBytes;
		const totalBytes = patch.totalBytes ?? current.totalBytes;
		const operation = {
			revision: current.revision + 1,
			operationId,
			target: copyTarget(current.target),
			...(current.sourceFingerprint ? { sourceFingerprint: current.sourceFingerprint } : {}),
			downloadedBytes,
			...(totalBytes === undefined ? {} : { totalBytes }),
		};
		let next: LocalEmbeddingAcquisitionState;
		switch (patch.phase) {
			case "preparing":
			case "downloading":
			case "validating":
				next = { ...operation, phase: patch.phase };
				break;
			case "completed":
			case "cancelled":
				next = { ...operation, phase: patch.phase };
				break;
			case "failed":
				next = { ...operation, phase: patch.phase, errorCode: patch.errorCode };
				break;
			case "interrupted":
				next = { ...operation, phase: patch.phase, errorCode: patch.errorCode };
				break;
		}
		await this.replaceState(next);
	}

	private async replaceState(next: LocalEmbeddingAcquisitionState): Promise<void> {
		await this.persist(next);
		this.state = copyState(next);
		this.onStateChange?.(copyState(next));
	}

	private async persist(state: LocalEmbeddingAcquisitionState): Promise<void> {
		await mkdir(this.cacheRoot, { recursive: true });
		const temporary = join(this.cacheRoot, `.acquisition-state-${randomUUID()}.tmp`);
		let handle: FileHandle | undefined;
		try {
			handle = await open(temporary, "wx");
			await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporary, this.statePath);
		} finally {
			await handle?.close().catch(() => undefined);
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	private async isFile(path: string): Promise<boolean> {
		try {
			return (await stat(path)).isFile();
		} catch (error) {
			if (isMissingFile(error)) return false;
			throw error;
		}
	}
}
