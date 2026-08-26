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
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CredentialStatus, CredentialStore } from "./credential-store.js";

const BUILTIN_PROVIDER_IDS = new Set<string>(getBuiltinProviders());

function isBuiltinProvider(providerId: string): boolean {
	return BUILTIN_PROVIDER_IDS.has(providerId);
}

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
function safeBaseUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	try {
		const endpoint = new URL(value);
		if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return undefined;
		// Provider config may contain credentials in URL userinfo or query
		// parameters. Neither is model-service metadata safe to project.
		endpoint.username = "";
		endpoint.password = "";
		endpoint.search = "";
		endpoint.hash = "";
		return endpoint.toString().replace(/\/$/, "");
	} catch {
		return undefined;
	}
}

function parseHttpEndpoint(value: string): URL {
	let endpoint: URL;
	try {
		endpoint = new URL(value);
	} catch {
		throw { kind: "invalid_request", reason: "custom_provider_url_invalid" };
	}
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
		throw { kind: "invalid_request", reason: "custom_provider_url_invalid" };
	}
	endpoint.username = "";
	endpoint.password = "";
	endpoint.search = "";
	endpoint.hash = "";
	return endpoint;
}

function readProviderDocument(modelsPath: string): {
	document: Record<string, unknown>;
	providers: Record<string, unknown>;
} {
	if (!existsSync(modelsPath)) return { document: {}, providers: {} };
	try {
		const document = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, unknown>;
		return {
			document,
			providers: isRecord(document.providers) ? document.providers : {},
		};
	} catch {
		throw { kind: "conflict", reason: "custom_provider_config_invalid" };
	}
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
	/** Whether this provider comes from pi-ai's immutable builtin catalog or Pi config. */
	source: "builtin" | "custom";
	/** Projection of explicit credentials and/or persisted Pi provider config. */
	added: boolean;
	authType: "api_key" | "oauth";
	credentialStatus: ProviderCredentialStatus;
	/**
	 * Effective endpoint selected by pi-ai after persisted provider
	 * configuration is composed. This projection is deliberately credential
	 * free: userinfo, query parameters, and fragments are removed.
	 */
	baseUrl?: string;
	availableModels: ProviderModelInfo[];
	/** This provider's id when pi-ai reported an auth error during the probe. */
	unavailable: string[];
}

/** Host-level summary of an OAuth login flow. */
export interface OAuthLoginResult {
	authUrl?: string;
	instructions?: string;
	deviceCode?: string;
	verificationUri?: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
}

export interface OAuthSessionState extends OAuthLoginResult {
	providerId: string;
	status: "running" | "waiting_input" | "completed" | "failed";
	message?: string;
	/** Links from pi-ai `info` events (e.g. help/terms pages). */
	infoLinks?: readonly { url: string; label?: string }[];
	prompt?: {
		type: "text" | "secret" | "select" | "manual_code";
		message: string;
		placeholder?: string;
		options?: readonly { id: string; label: string; description?: string }[];
	};
}

interface OAuthSessionInternal extends OAuthSessionState {
	resolvePrompt?: (answer: string) => void;
	rejectPrompt?: (cause: Error) => void;
	abort?: AbortController;
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

	/** Return the canonical pi-coding-agent runtime used by Companion sessions. */
	async getModels(): Promise<ModelRuntime> {
		return this.getRuntime();
	}

	async upsertCustomProvider(input: {
		providerId: string;
		name: string;
		baseUrl: string;
		models: readonly { id: string; name?: string; supportsImages?: boolean }[];
		apiKey?: string;
	}): Promise<void> {
		assertCustomProviderId(input.providerId);
		assertAllowedProvider(input.providerId);
		const endpoint = parseHttpEndpoint(input.baseUrl);
		const modelsPath = join(this.agentDir, "models.json");
		const temporaryPath = `${modelsPath}.tmp`;
		const { document, providers } = readProviderDocument(modelsPath);
		const current = providers[input.providerId];
		const currentConfig =
			current && typeof current === "object" && !Array.isArray(current)
				? (current as Record<string, unknown>)
				: {};
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
							name: input.name,
							baseUrl: endpoint.toString().replace(/\/$/, ""),
							api: "openai-completions",
							authHeader: true,
							models: input.models.map((model) => ({
								id: model.id,
								name: model.name ?? model.id,
								...(model.supportsImages ? { input: ["text", "image"] } : {}),
							})),
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
		for (const [providerId, config] of Object.entries(fragment.providers)) {
			if (
				isBuiltinProvider(providerId) &&
				isRecord(config) &&
				("models" in config || "modelOverrides" in config)
			) {
				throw {
					kind: "invalid_request",
					reason: "pi_model_config_builtin_catalog_forbidden",
				};
			}
		}
		const importedRoutes = configuredRoutes(fragment.providers);
		if (
			importedRoutes.length === 0 &&
			Object.keys(fragment.providers).some((providerId) => !isBuiltinProvider(providerId))
		) {
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
		const endpoint = parseHttpEndpoint(input.baseUrl);
		const modelsPath = join(this.agentDir, "models.json");
		const temporaryPath = `${modelsPath}.tmp`;
		const { document, providers } = readProviderDocument(modelsPath);
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
		const { providers: persistedProviders } = readProviderDocument(
			join(this.agentDir, "models.json"),
		);

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
			const runtimeAuthStatus = runtime.getProviderAuthStatus(provider.id);
			const credentialStatus =
				hostStatus === "stored" || hostStatus === "weak_storage"
					? "stored"
					: mapCredentialStatus(runtimeAuthStatus);
			const hasExplicitCredential =
				hostStatus === "stored" ||
				hostStatus === "weak_storage" ||
				hostStatus === "session_only" ||
				(runtimeAuthStatus.configured && runtimeAuthStatus.source !== "environment");
			const added = Object.hasOwn(persistedProviders, provider.id) || hasExplicitCredential;
			providers.push({
				id: provider.id,
				name: provider.name,
				source: isBuiltinProvider(provider.id) ? "builtin" : "custom",
				added,
				authType: provider.auth.oauth ? "oauth" : "api_key",
				credentialStatus,
				baseUrl: safeBaseUrl(provider.baseUrl),
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

	/**
	 * Remove every local trace of a provider while preserving the immutable
	 * builtin catalog entry. Credentials and Pi config are independent
	 * projections, so both are cleared before the cached Pi runtime is
	 * invalidated.
	 */
	async removeProvider(providerId: string): Promise<void> {
		assertAllowedProvider(providerId);
		this.abortOAuthSession(providerId);
		const runtime = await this.getRuntime();
		const logoutOptions = { revokeAccessToken: false } as { signal?: AbortSignal };
		try {
			await runtime.logout(providerId, logoutOptions);
		} catch {
			// Local cleanup must continue even when pi-ai has no active session.
		}
		await this.credentialStore.remove(providerId);

		const modelsPath = join(this.agentDir, "models.json");
		if (existsSync(modelsPath)) {
			const { document, providers } = readProviderDocument(modelsPath);
			if (Object.hasOwn(providers, providerId)) {
				const remainingProviders = { ...providers };
				delete remainingProviders[providerId];
				const temporaryPath = `${modelsPath}.tmp`;
				mkdirSync(dirname(modelsPath), { recursive: true, mode: 0o700 });
				writeFileSync(
					temporaryPath,
					`${JSON.stringify({ ...document, providers: remainingProviders }, null, 2)}\n`,
					{ mode: 0o600 },
				);
				renameSync(temporaryPath, modelsPath);
			}
		}
		this.runtime = null;
	}
	/** Local logout: clear runtime + host credentials; never revoke tokens. */
	async logout(providerId: string): Promise<void> {
		this.abortOAuthSession(providerId);
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
		let instructions: string | undefined;
		let deviceCode: string | undefined;
		let verificationUri: string | undefined;
		let intervalSeconds: number | undefined;
		let expiresInSeconds: number | undefined;
		const capturingInteraction: AuthInteraction = {
			signal: interaction.signal,
			prompt: interaction.prompt,
			notify: (event) => {
				if (event.type === "auth_url") {
					authUrl = event.url;
					instructions = event.instructions;
				} else if (event.type === "device_code") {
					deviceCode = event.userCode;
					verificationUri = event.verificationUri;
					intervalSeconds = event.intervalSeconds;
					expiresInSeconds = event.expiresInSeconds;
				}
				interaction.notify(event);
			},
		};
		try {
			await runtime.login(providerId, "oauth", capturingInteraction);
		} catch (error) {
			throw toHostError(error, providerId);
		}
		return {
			authUrl,
			instructions,
			deviceCode,
			verificationUri,
			intervalSeconds,
			expiresInSeconds,
		};
	}

	startOAuth(providerId: string): OAuthSessionState {
		const current = this.oauthSessions.get(providerId);
		if (current && (current.status === "running" || current.status === "waiting_input")) {
			return publicOAuthSession(current);
		}
		const session: OAuthSessionInternal = { providerId, status: "running" };
		this.oauthSessions.set(providerId, session);
		session.abort = new AbortController();
		void this.loginOAuth(providerId, {
			signal: session.abort.signal,
			notify: (event) => {
				if (event.type === "auth_url") {
					session.authUrl = event.url;
					session.instructions = event.instructions;
				}
				if (event.type === "device_code") {
					session.deviceCode = event.userCode;
					session.verificationUri = event.verificationUri;
					session.intervalSeconds = event.intervalSeconds;
					session.expiresInSeconds = event.expiresInSeconds;
				}
				if (event.type === "info") {
					session.message = event.message;
					if (event.links?.length) session.infoLinks = event.links;
				}
				if (event.type === "progress") session.message = event.message;
			},
			prompt: (prompt) =>
				new Promise<string>((resolve, reject) => {
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
					session.rejectPrompt = reject;
				}),
		})
			.then((result) => {
				Object.assign(session, result);
				session.status = "completed";
				session.message = undefined;
				session.infoLinks = undefined;
				session.prompt = undefined;
				session.resolvePrompt = undefined;
				session.rejectPrompt = undefined;
			})
			.catch((cause) => {
				session.status = "failed";
				session.prompt = undefined;
				session.resolvePrompt = undefined;
				session.rejectPrompt = undefined;
				session.message = oauthFailureReason(cause);
			});
		return publicOAuthSession(session);
	}

	/** Cancel an in-flight OAuth login flow for a provider. */
	cancelOAuth(providerId: string): void {
		if (!this.oauthSessions.has(providerId)) {
			throw { kind: "not_found", reason: "oauth_session_not_found" };
		}
		this.abortOAuthSession(providerId);
	}

	private abortOAuthSession(providerId: string): void {
		const session = this.oauthSessions.get(providerId);
		if (!session) return;
		session.abort?.abort();
		session.rejectPrompt?.(new DOMException("OAuth login cancelled", "AbortError"));
		session.rejectPrompt = undefined;
		session.resolvePrompt = undefined;
		this.oauthSessions.delete(providerId);
	}

	/** Drop the cached runtime and abort every in-flight OAuth flow (window teardown). */
	dispose(): void {
		for (const providerId of [...this.oauthSessions.keys()]) this.abortOAuthSession(providerId);
		this.runtime = null;
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
		session.rejectPrompt = undefined;
		session.prompt = undefined;
		session.status = "running";
		resolve(answer);
		return publicOAuthSession(session);
	}

	/** Host credential status for a provider (from the CredentialStore). */
	async authStatus(providerId: string): Promise<CredentialStatus> {
		return this.credentialStore.getStatus(providerId);
	}
}

function publicOAuthSession(session: OAuthSessionInternal): OAuthSessionState {
	const {
		resolvePrompt: _resolvePrompt,
		rejectPrompt: _rejectPrompt,
		abort: _abort,
		...result
	} = session;
	return result;
}

function assertCustomProviderId(providerId: string): void {
	if (isBuiltinProvider(providerId)) {
		throw { kind: "invalid_request", reason: `custom_provider_must_be_custom: ${providerId}` };
	}
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

/**
 * Language-neutral reason for a failed OAuth session, extracted without
 * throwing so the session catch can record it on the session object.
 */
function oauthFailureReason(error: unknown): string {
	if (typeof error === "object" && error !== null && "kind" in error && "reason" in error) {
		const { reason } = error as { reason: unknown };
		if (typeof reason === "string" && reason) return reason;
	}
	if (error instanceof Error && (error.name === "AbortError" || error.name === "DOMException")) {
		return "login_aborted";
	}
	const message = error instanceof Error ? error.message : String(error);
	return message || "login_failed";
}
