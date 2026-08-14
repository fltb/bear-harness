/**
 * ProviderCatalog — host-side wrapper around the pi-ai ModelRuntime.
 *
 * pi-ai is the only provider engine: its static catalog, OAuth/auth flows,
 * credential synchronization, and availability probing all live in the SDK.
 * The host contributes only:
 *   1. safeStorage-backed CredentialStore (host persistence for API keys),
 *   2. product policy (provider-id filtering, no ambient-env trust),
 *   3. AuthInteraction -> dialog mapping (renderer side),
 *   4. Voice Stack pinning.
 *
 * The runtime is created lazily with `refreshOnCreate: false` so app startup
 * never blocks on catalog work; `listProviders()` runs the local-only probe
 * that populates the runtime's auth snapshot and collects per-provider
 * auth errors reported by pi-ai.
 */

import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CredentialStatus, CredentialStore } from "./credential-store.js";

/**
 * Product policy: provider ids the host never surfaces or accepts
 * credentials for. Keeps anthropic, openai, deepseek, zai, openrouter,
 * groq, mistral, minimax, moonshotai, kimi-coding, opencode, opencode-go.
 */
const BLOCKED_PROVIDER_ID_PATTERN =
	/bedrock|vertex|radius|copilot|nvidia|cerebras|huggingface|fireworks|together|baseten|cloudflare|azure|xiaomi|qwen-token/i;

/** Auth events emitted by provider login flows (mirrors pi-ai's AuthEvent). */
export type AuthEvent =
	| { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

/** Prompt shapes the host's dialog layer must support (mirrors pi-ai). */
export type AuthPrompt = { signal?: AbortSignal } & (
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| {
			type: "select";
			message: string;
			options: readonly { id: string; label: string; description?: string }[];
	  }
	| { type: "manual_code"; message: string; placeholder?: string }
);

/** Login interaction contract passed through to pi-ai verbatim. */
export interface AuthInteraction {
	signal?: AbortSignal;
	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
}

/** Credential status reported by the catalog, mapped from pi-ai auth status. */
export type ProviderCredentialStatus = "missing" | "session_only" | "stored" | "unavailable";

/** Per-model pricing (mirrors pi-ai's ModelCost shape). */
export interface ProviderModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: Array<ProviderModelCost & { inputTokensAbove: number }>;
}

/** A model entry surfaced by the catalog. */
export interface ProviderModelInfo {
	id: string;
	name: string;
	supportsImages: boolean;
	cost: ProviderModelCost;
}

/** One provider entry in the catalog listing. */
export interface ProviderInfo {
	id: string;
	name: string;
	authType: "api_key" | "oauth";
	credentialStatus: ProviderCredentialStatus;
	availableModels: ProviderModelInfo[];
	/** This provider's id when pi-ai reported an auth error during the probe. */
	unavailable: string[];
}

/** Host-level summary of an OAuth login flow. */
export interface OAuthLoginResult {
	authUrl?: string;
	deviceCode?: string;
	verificationUri?: string;
}

export class ProviderCatalog {
	private runtime: Promise<ModelRuntime> | null = null;

	constructor(
		private readonly credentialStore: CredentialStore,
		private readonly agentDir: string,
	) {}

	/** Lazily create (and cache) the pi-ai runtime; never refresh on create. */
	private async getRuntime(): Promise<ModelRuntime> {
		if (!this.runtime) {
			this.runtime = ModelRuntime.create({
				authPath: join(this.agentDir, "auth.json"),
				modelsPath: join(this.agentDir, "models.json"),
				refreshOnCreate: false,
			}).catch((error) => {
				// A failed create must not poison the cache for later retries.
				this.runtime = null;
				throw error;
			});
		}
		return this.runtime;
	}

	/** List providers visible to the product, with models and credential status. */
	async listProviders(): Promise<ProviderInfo[]> {
		const runtime = await this.getRuntime();

		// Local-only probe: populate the runtime's auth snapshot
		// (configured/stored providers) and collect per-provider auth errors.
		const errored = new Set<string>();
		try {
			const result = await runtime.refresh({ allowNetwork: false });
			for (const providerId of result.errors.keys()) errored.add(providerId);
		} catch {
			// A failed probe never hides the static catalog.
		}

		const providers: ProviderInfo[] = [];
		for (const provider of runtime.getProviders()) {
			if (BLOCKED_PROVIDER_ID_PATTERN.test(provider.id)) continue;
			providers.push({
				id: provider.id,
				name: provider.name,
				authType: provider.auth.oauth ? "oauth" : "api_key",
				credentialStatus: mapCredentialStatus(runtime.getProviderAuthStatus(provider.id)),
				availableModels: runtime.getModels(provider.id).map((model) => ({
					id: model.id,
					name: model.name,
					supportsImages: model.input.includes("image"),
					cost: model.cost,
				})),
				unavailable: errored.has(provider.id) ? [provider.id] : [],
			});
		}
		return providers;
	}

	/** Persist an API key in the runtime and the host credential store. */
	async setApiKey(providerId: string, apiKey: string, sessionOnly?: boolean): Promise<void> {
		assertAllowedProvider(providerId);
		const runtime = await this.getRuntime();
		if (!runtime.getProvider(providerId)) {
			throw { kind: "not_found", reason: `provider_not_found: ${providerId}` };
		}
		try {
			await runtime.setRuntimeApiKey(providerId, apiKey);
		} catch (error) {
			throw toHostError(error, providerId);
		}
		await this.credentialStore.set(providerId, { apiKey }, { sessionOnly });
	}

	/** Local logout: clear runtime + host credentials; never revoke tokens. */
	async logout(providerId: string): Promise<void> {
		const runtime = await this.getRuntime();
		// The 0.84 SDK logout is local-only and takes no options; the flag
		// documents the host's intent for SDK versions that add remote
		// revocation and is a runtime no-op here.
		const logoutOptions = { revokeAccessToken: false } as { signal?: AbortSignal };
		try {
			await runtime.logout(providerId, logoutOptions);
		} catch {
			// Best-effort: host credentials are still removed below.
		}
		await this.credentialStore.remove(providerId);
	}

	/** Run a provider's OAuth flow, surfacing the auth URL / device code. */
	async loginOAuth(providerId: string, interaction: AuthInteraction): Promise<OAuthLoginResult> {
		assertAllowedProvider(providerId);
		const runtime = await this.getRuntime();
		let authUrl: string | undefined;
		let deviceCode: string | undefined;
		let verificationUri: string | undefined;
		const capturingInteraction: AuthInteraction = {
			signal: interaction.signal,
			prompt: interaction.prompt,
			notify: (event) => {
				if (event.type === "auth_url") authUrl = event.url;
				else if (event.type === "device_code") {
					deviceCode = event.userCode;
					verificationUri = event.verificationUri;
				}
				interaction.notify(event);
			},
		};
		try {
			await runtime.login(providerId, "oauth", capturingInteraction);
		} catch (error) {
			throw toHostError(error, providerId);
		}
		return { authUrl, deviceCode, verificationUri };
	}

	/** Host credential status for a provider (from the CredentialStore). */
	async authStatus(providerId: string): Promise<CredentialStatus> {
		return this.credentialStore.getStatus(providerId);
	}

	/** Drop the cached runtime (e.g. on window teardown). */
	dispose(): void {
		this.runtime = null;
	}
}

function assertAllowedProvider(providerId: string): void {
	if (BLOCKED_PROVIDER_ID_PATTERN.test(providerId)) {
		throw { kind: "invalid_request", reason: `provider_not_allowed: ${providerId}` };
	}
}

function mapCredentialStatus(status: { configured: boolean; source?: string }): ProviderCredentialStatus {
	if (!status.configured) return "missing";
	switch (status.source) {
		case "stored":
			return "stored";
		case "runtime":
			return "session_only";
		case "environment":
			return "unavailable";
		default:
			return "missing";
	}
}

function toHostError(error: unknown, providerId: string): never {
	// Pass host-thrown { kind, reason } errors through untouched (e.g. a
	// cancelled dialog prompt surfaced by the interaction).
	if (typeof error === "object" && error !== null && "kind" in error && "reason" in error) {
		throw error as { kind: string; reason: string };
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/unknown provider/i.test(message)) {
		throw { kind: "not_found", reason: `provider_not_found: ${providerId}` };
	}
	if (/does not support/i.test(message)) {
		throw { kind: "invalid_request", reason: message };
	}
	// User-cancelled flows surface as AbortError (the SDK normalizes prompt
	// rejections into plain Errors, so the interaction signal is the reliable
	// cancel path).
	if (error instanceof Error && (error.name === "AbortError" || error.name === "DOMException")) {
		throw { kind: "conflict", reason: "login_aborted" };
	}
	throw { kind: "internal", reason: message };
}
