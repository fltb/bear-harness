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

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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

interface ProviderModelInfoWithProvider {
	providerId: string;
	modelId: string;
	name: string;
	supportsImages: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsKey(value: unknown, key: string): boolean {
	if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
	if (!isRecord(value)) return false;
	return key in value || Object.values(value).some((item) => containsKey(item, key));
}

function configuredRoutes(providers: Record<string, unknown>): Array<{
	providerId: string;
	modelId: string;
}> {
	return Object.entries(providers).flatMap(([providerId, config]) => {
		if (!isRecord(config) || !Array.isArray(config.models)) return [];
		return config.models.flatMap((model) =>
			isRecord(model) && typeof model.id === "string" && model.id
				? [{ providerId, modelId: model.id }]
				: [],
		);
	});
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

export interface OAuthSessionState extends OAuthLoginResult {
	providerId: string;
	status: "running" | "waiting_input" | "completed" | "failed";
	message?: string;
	prompt?: {
		type: "text" | "secret" | "select" | "manual_code";
		message: string;
		placeholder?: string;
		options?: readonly { id: string; label: string; description?: string }[];
	};
}

interface OAuthSessionInternal extends OAuthSessionState {
	resolvePrompt?: (answer: string) => void;
}

export class ProviderCatalog {
	private runtime: Promise<ModelRuntime> | null = null;
	private oauthSessions = new Map<string, OAuthSessionInternal>();

	constructor(
		private readonly credentialStore: CredentialStore,
		private readonly agentDir: string,
	) {}

	/** Lazily create (and cache) the pi-ai runtime; never refresh on create. */
	private async getRuntime(): Promise<ModelRuntime> {
		if (!this.runtime) {
			this.runtime = this.createRuntime().catch((error) => {
				// A failed create must not poison the cache for later retries.
				this.runtime = null;
				throw error;
			});
		}
		return this.runtime;
	}

	private async createRuntime(): Promise<ModelRuntime> {
		const runtime = await ModelRuntime.create({
			authPath: join(this.agentDir, "auth.json"),
			modelsPath: join(this.agentDir, "models.json"),
			refreshOnCreate: false,
		});
		for (const account of await this.credentialStore.list()) {
			if (account.status === "invalid" || account.status === "unavailable") continue;
			const credential = await this.credentialStore.get(account.providerId);
			if (!credential?.apiKey || BLOCKED_PROVIDER_ID_PATTERN.test(account.providerId)) continue;
			if (!runtime.getProvider(account.providerId)) continue;
			await runtime.setRuntimeApiKey(account.providerId, credential.apiKey);
		}
		return runtime;
	}

	/** Shared in-process runtime for the Companion session after Host auth policy. */
	async getModelRuntime(): Promise<ModelRuntime> {
		return this.getRuntime();
	}

	/** Core runtime consumes pi-ai's Models interface directly. */
	async getModels(): Promise<ModelRuntime> {
		return this.getRuntime();
	}

	async upsertCustomProvider(input: {
		providerId: string;
		name: string;
		baseUrl: string;
		modelId: string;
		apiKey?: string;
		supportsImages?: boolean;
	}): Promise<void> {
		assertAllowedProvider(input.providerId);
		let endpoint: URL;
		try {
			endpoint = new URL(input.baseUrl);
		} catch {
			throw { kind: "invalid_request", reason: "custom_provider_url_invalid" };
		}
		if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
			throw { kind: "invalid_request", reason: "custom_provider_url_invalid" };
		}
		const modelsPath = join(this.agentDir, "models.json");
		const temporaryPath = `${modelsPath}.tmp`;
		let providers: Record<string, unknown> = {};
		if (existsSync(modelsPath)) {
			try {
				const current = JSON.parse(readFileSync(modelsPath, "utf8")) as { providers?: unknown };
				if (current.providers && typeof current.providers === "object") {
					providers = current.providers as Record<string, unknown>;
				}
			} catch {
				throw { kind: "conflict", reason: "custom_provider_config_invalid" };
			}
		}
		mkdirSync(dirname(modelsPath), { recursive: true, mode: 0o700 });
		writeFileSync(
			temporaryPath,
			`${JSON.stringify(
				{
					providers: {
						...providers,
						[input.providerId]: {
							name: input.name,
							baseUrl: endpoint.toString().replace(/\/$/, ""),
							api: "openai-completions",
							authHeader: true,
							models: [
								{
									id: input.modelId,
									name: input.modelId,
									...(input.supportsImages ? { input: ["text", "image"] } : {}),
								},
							],
						},
					},
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
		renameSync(temporaryPath, modelsPath);
		this.runtime = null;
		if (input.apiKey) await this.setApiKey(input.providerId, input.apiKey);
	}

	async importPiConfig(configJson: string): Promise<ProviderModelInfoWithProvider[]> {
		let fragment: unknown;
		try {
			fragment = JSON.parse(configJson);
		} catch {
			throw { kind: "invalid_request", reason: "pi_model_config_invalid_json" };
		}
		if (!isRecord(fragment) || !isRecord(fragment.providers)) {
			throw { kind: "invalid_request", reason: "pi_model_config_requires_providers" };
		}
		if (containsKey(fragment, "apiKey")) {
			throw { kind: "invalid_request", reason: "pi_model_config_must_not_contain_api_key" };
		}
		const importedRoutes = configuredRoutes(fragment.providers);
		if (importedRoutes.length === 0) {
			throw { kind: "invalid_request", reason: "pi_model_config_requires_models" };
		}

		const modelsPath = join(this.agentDir, "models.json");
		const temporaryPath = `${modelsPath}.tmp`;
		const previous = existsSync(modelsPath) ? readFileSync(modelsPath, "utf8") : undefined;
		let document: Record<string, unknown> = {};
		if (previous) {
			try {
				document = JSON.parse(previous) as Record<string, unknown>;
			} catch {
				throw { kind: "conflict", reason: "custom_provider_config_invalid" };
			}
		}
		const providers = isRecord(document.providers) ? document.providers : {};
		mkdirSync(dirname(modelsPath), { recursive: true, mode: 0o700 });
		writeFileSync(
			temporaryPath,
			`${JSON.stringify({ ...document, providers: { ...providers, ...fragment.providers } }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		renameSync(temporaryPath, modelsPath);
		try {
			const runtime = await ModelRuntime.create({
				authPath: join(this.agentDir, "auth.json"),
				modelsPath,
				refreshOnCreate: false,
			});
			const result = importedRoutes.map((route) => {
				const model = runtime.getModel(route.providerId, route.modelId);
				if (!model) throw new Error(`Pi did not register ${route.providerId}/${route.modelId}`);
				return {
					providerId: route.providerId,
					modelId: model.id,
					name: model.name,
					supportsImages: model.input.includes("image"),
				};
			});
			this.runtime = null;
			return result;
		} catch {
			if (previous === undefined) unlinkSync(modelsPath);
			else writeFileSync(modelsPath, previous, { mode: 0o600 });
			this.runtime = null;
			throw { kind: "invalid_request", reason: "pi_model_config_rejected" };
		}
	}

	async overrideProviderBaseUrl(input: { providerId: string; baseUrl: string }): Promise<void> {
		assertAllowedProvider(input.providerId);
		let endpoint: URL;
		try {
			endpoint = new URL(input.baseUrl);
		} catch {
			throw { kind: "invalid_request", reason: "custom_provider_url_invalid" };
		}
		if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
			throw { kind: "invalid_request", reason: "custom_provider_url_invalid" };
		}
		const modelsPath = join(this.agentDir, "models.json");
		const temporaryPath = `${modelsPath}.tmp`;
		let document: Record<string, unknown> = {};
		let providers: Record<string, unknown> = {};
		if (existsSync(modelsPath)) {
			try {
				document = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, unknown>;
				if (document.providers && typeof document.providers === "object") {
					providers = document.providers as Record<string, unknown>;
				}
			} catch {
				throw { kind: "conflict", reason: "custom_provider_config_invalid" };
			}
		}
		const current = providers[input.providerId];
		const currentConfig =
			current && typeof current === "object" ? (current as Record<string, unknown>) : {};
		mkdirSync(dirname(modelsPath), { recursive: true, mode: 0o700 });
		writeFileSync(
			temporaryPath,
			`${JSON.stringify(
				{
					...document,
					providers: {
						...providers,
						[input.providerId]: {
							...currentConfig,
							baseUrl: endpoint.toString().replace(/\/$/, ""),
						},
					},
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
		renameSync(temporaryPath, modelsPath);
		this.runtime = null;
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
			const hostStatus = await this.credentialStore.getStatus(provider.id);
			providers.push({
				id: provider.id,
				name: provider.name,
				authType: provider.auth.oauth ? "oauth" : "api_key",
				credentialStatus:
					hostStatus === "stored" || hostStatus === "weak_storage"
						? "stored"
						: mapCredentialStatus(runtime.getProviderAuthStatus(provider.id)),
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

	startOAuth(providerId: string): OAuthSessionState {
		const current = this.oauthSessions.get(providerId);
		if (current && (current.status === "running" || current.status === "waiting_input")) {
			return publicOAuthSession(current);
		}
		const session: OAuthSessionInternal = { providerId, status: "running" };
		this.oauthSessions.set(providerId, session);
		void this.loginOAuth(providerId, {
			notify: (event) => {
				if (event.type === "auth_url") session.authUrl = event.url;
				if (event.type === "device_code") {
					session.deviceCode = event.userCode;
					session.verificationUri = event.verificationUri;
				}
				if (event.type === "info" || event.type === "progress") session.message = event.message;
			},
			prompt: (prompt) =>
				new Promise<string>((resolve) => {
					session.status = "waiting_input";
					session.prompt = {
						type: prompt.type,
						message: prompt.message,
						...("placeholder" in prompt && prompt.placeholder
							? { placeholder: prompt.placeholder }
							: {}),
						...(prompt.type === "select" ? { options: prompt.options } : {}),
					};
					session.resolvePrompt = resolve;
				}),
		})
			.then((result) => {
				Object.assign(session, result);
				session.status = "completed";
				session.prompt = undefined;
				session.resolvePrompt = undefined;
			})
			.catch(() => {
				session.status = "failed";
				session.message = "登录没有完成，请重试。";
				session.prompt = undefined;
				session.resolvePrompt = undefined;
			});
		return publicOAuthSession(session);
	}

	getOAuthSession(providerId: string): OAuthSessionState {
		const session = this.oauthSessions.get(providerId);
		if (!session) throw { kind: "not_found", reason: "oauth_session_not_found" };
		return publicOAuthSession(session);
	}

	answerOAuth(providerId: string, answer: string): OAuthSessionState {
		const session = this.oauthSessions.get(providerId);
		if (!session?.resolvePrompt || session.status !== "waiting_input") {
			throw { kind: "conflict", reason: "oauth_input_not_requested" };
		}
		const resolve = session.resolvePrompt;
		session.resolvePrompt = undefined;
		session.prompt = undefined;
		session.status = "running";
		resolve(answer);
		return publicOAuthSession(session);
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

function publicOAuthSession(session: OAuthSessionInternal): OAuthSessionState {
	const { resolvePrompt: _resolvePrompt, ...result } = session;
	return result;
}

function assertAllowedProvider(providerId: string): void {
	if (BLOCKED_PROVIDER_ID_PATTERN.test(providerId)) {
		throw { kind: "invalid_request", reason: `provider_not_allowed: ${providerId}` };
	}
}

function mapCredentialStatus(status: {
	configured: boolean;
	source?: string;
}): ProviderCredentialStatus {
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
