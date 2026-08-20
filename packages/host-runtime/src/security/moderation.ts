/**
 * Text moderation: a deterministic local baseline plus an optional pluggable
 * remote policy service.
 *
 * Design principles:
 * - Fail-open everywhere. Local rules are pure string checks (they cannot
 *   throw), and any remote error (network, timeout, malformed response)
 *   resolves to `allowed: true`. Moderation must never brick the host.
 * - Local rules are a small, documented safety net (control characters,
 *   length, prompt-injection boundary markers, path-escape attempts) that
 *   applies before the remote service is consulted. If the local baseline
 *   rejects, the text is rejected regardless of what the remote says.
 * - The remote endpoint is optional: when absent, only the local baseline
 *   runs. When present, it is POSTed `{ text, scene }` with a bearer token
 *   and must answer `{ allowed, reason? }`.
 */

const MAX_TEXT_LENGTH = 10_000;

/** C0 control characters except tab/newline/carriage-return, plus DEL. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional validation of forbidden C0 characters.
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/**
 * Prompt-injection boundary markers: lines that try to override the
 * system/host policy. Case-insensitive, matched per line.
 */
const PROMPT_INJECTION_RES: RegExp[] = [
	/\bignore\s+(?:(?:all|any|previous|prior|above|earlier|your)\s+){0,2}(?:instructions?|prompts?|directives?|system|context|messages?)\b/i,
	/\bdisregard\s+(?:(?:all|any|previous|prior)\s+){0,2}(?:instructions?|prompts?|directives?|system)\b/i,
	/\bforget\s+(?:(?:all|any|previous|prior|your)\s+){0,2}(?:instructions?|prompts?|directives?|system)\b/i,
];

/**
 * File-path escape attempts: parent-directory segments (`..` as a path
 * element) and Windows drive-absolute paths. Applied only to scenes that
 * embed identity/memory text, where such escapes could redirect storage.
 */
const PARENT_DIR_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const WINDOWS_DRIVE_RE = /\b[a-zA-Z]:[\\/]/;

/** Scenes in which path-escape rules apply ("where relevant"). */
const PATH_SCENE_RES = [/identity/i, /memory/i];

export interface ModerationResult {
	allowed: boolean;
	reason?: string;
}

/** Minimal fetch surface used for the remote moderation call (injectable). */
export interface ModerationFetch {
	(
		url: string,
		init: {
			method: string;
			headers: Record<string, string>;
			body: string;
			signal: AbortSignal;
		},
	): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

export interface ModerationOptions {
	/** Optional remote moderation endpoint (full URL). POSTed `{ text, scene }`. */
	remoteEndpoint?: string;
	/** Bearer token sent to the remote endpoint when configured. */
	remoteApiKey?: string;
	/**
	 * Injectable fetch for tests. Defaults to the global fetch. Any rejection
	 * or non-2xx answer fails open (`allowed: true`).
	 */
	fetchImpl?: ModerationFetch;
	/** Remote request timeout in milliseconds; default 10s. */
	timeoutMs?: number;
	logger?: { warn?: (message: string) => void };
}

interface RemoteModerationResult {
	allowed: boolean;
	reason?: string;
}

export class ModerationService {
	private readonly remoteEndpoint?: string;
	private readonly remoteApiKey?: string;
	private readonly fetchImpl: ModerationFetch;
	private readonly timeoutMs: number;
	private readonly logger: { warn?: (message: string) => void };

	constructor(options: ModerationOptions = {}) {
		this.remoteEndpoint = options.remoteEndpoint?.trim() || undefined;
		this.remoteApiKey = options.remoteApiKey?.trim() || undefined;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.timeoutMs = options.timeoutMs ?? 10_000;
		this.logger = options.logger ?? {};
	}

	/**
	 * Check a piece of text for a given scene. Resolves `{ allowed: false }`
	 * with a reason when a local rule or the remote service rejects, and
	 * `{ allowed: true }` otherwise — including on any remote failure.
	 */
	async checkText(text: string, scene: string): Promise<ModerationResult> {
		if (typeof text !== "string") return { allowed: true };
		const local = this.checkLocal(text, scene);
		if (!local.allowed) return local;
		if (!this.remoteEndpoint || !this.remoteApiKey) return { allowed: true };
		const remote = await this.checkRemote(text, scene);
		return remote ?? { allowed: true };
	}

	/** Deterministic local rules. Never throws. */
	private checkLocal(text: string, scene: string): ModerationResult {
		if (CONTROL_CHARS_RE.test(text)) {
			return { allowed: false, reason: "control_characters" };
		}
		if (text.length > MAX_TEXT_LENGTH) {
			return { allowed: false, reason: "too_long" };
		}
		for (const line of text.split("\n")) {
			for (const re of PROMPT_INJECTION_RES) {
				if (re.test(line)) {
					return { allowed: false, reason: "prompt_injection" };
				}
			}
		}
		if (PATH_SCENE_RES.some((re) => re.test(scene))) {
			if (PARENT_DIR_RE.test(text) || WINDOWS_DRIVE_RE.test(text)) {
				return { allowed: false, reason: "path_escape" };
			}
		}
		return { allowed: true };
	}

	/** Remote policy check; any error fails open (returns null → allowed). */
	private async checkRemote(text: string, scene: string): Promise<RemoteModerationResult | null> {
		if (!this.remoteEndpoint || !this.remoteApiKey) return null;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await this.fetchImpl(this.remoteEndpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${this.remoteApiKey}`,
				},
				body: JSON.stringify({ text, scene }),
				signal: controller.signal,
			});
			if (!response.ok) return null;
			const data = (await response.json()) as {
				allowed?: unknown;
				reason?: unknown;
			};
			if (typeof data.allowed !== "boolean") return null;
			return {
				allowed: data.allowed,
				reason: typeof data.reason === "string" ? data.reason : undefined,
			};
		} catch (error) {
			this.logger.warn?.(
				`moderation remote check failed (failing open): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return null;
		} finally {
			clearTimeout(timer);
		}
	}
}

/** Create a moderation service (local baseline + optional remote policy). */
export function createModerationService(options: ModerationOptions = {}): ModerationService {
	return new ModerationService(options);
}
