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

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Credential as PiCredential } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	DurableFileTransactionError,
	recoverDurableFileTransaction,
	replaceDurableFile,
} from "../storage/durable-file-transaction.js";
import {
	type CredentialStatus,
	type CredentialStore,
	EncryptedPiCredentialStore,
} from "./credential-store.js";

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

function isPiCredential(value: unknown): value is PiCredential {
	if (!isRecord(value)) return false;
	if (value.type === "api_key") {
		return value.key === undefined || typeof value.key === "string";
	}
	return (
		value.type === "oauth" &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	);
}

const SECRET_KEY_PARTS = [
	"apikey",
	"accesstoken",
	"refreshtoken",
	"authorization",
	"password",
	"clientsecret",
] as const;
const EXACT_SECRET_KEYS = [
	"token",
	"secret",
	"credential",
	"auth",
	"bearer",
	"cookie",
	"privatekey",
] as const;

function isCredentialKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	return (
		SECRET_KEY_PARTS.some((part) => normalized.includes(part)) ||
		EXACT_SECRET_KEYS.some((secretKey) => normalized === secretKey)
	);
}

function containsCredential(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsCredential);
	if (!isRecord(value)) return false;
	return Object.entries(value).some(
		([key, item]) => isCredentialKey(key) || containsCredential(item),
	);
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
		const document = JSON.parse(readFileSync(modelsPath, "utf8")) as unknown;
		if (!isRecord(document)) throw new Error("models document must be an object");
		if ("providers" in document && !isRecord(document.providers)) {
			throw new Error("providers must be an object");
		}
		if (containsCredential(document)) throw new Error("models document contains credentials");
		const providers = isRecord(document.providers) ? document.providers : {};
		for (const [providerId, config] of Object.entries(providers)) {
			if (!providerId || !isRecord(config)) throw new Error("provider config must be an object");
			if ("baseUrl" in config) validatePersistedBaseUrl(config.baseUrl);
			if ("models" in config) {
				if (!Array.isArray(config.models) || config.models.length === 0) {
					throw new Error("provider models must be a non-empty array");
				}
				const ids = new Set<string>();
				for (const model of config.models) {
					if (!isRecord(model) || typeof model.id !== "string" || !model.id || ids.has(model.id)) {
						throw new Error("provider model ids must be non-empty and unique");
					}
					ids.add(model.id);
				}
			}
		}
		return { document, providers };
	} catch {
		throw { kind: "conflict", reason: "custom_provider_config_invalid" };
	}
}

function validatePersistedBaseUrl(value: unknown): void {
	if (typeof value !== "string") throw new Error("provider baseUrl must be a string");
	const endpoint = new URL(value);
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
		throw new Error("provider baseUrl must use HTTP");
	}
	if (endpoint.username || endpoint.password)
		throw new Error("provider baseUrl contains credentials");
	for (const key of endpoint.searchParams.keys()) {
		if (isCredentialKey(key) || key.toLowerCase().replace(/[^a-z0-9]/g, "") === "key") {
			throw new Error("provider baseUrl contains credentials");
		}
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

export type ProviderAuthMethod =
	| { type: "api_key"; name: string }
	| { type: "oauth"; name: string; loginLabel?: string; isSubscription?: boolean };

/** One provider entry in the catalog listing. */
export interface ProviderInfo {
	id: string;
	name: string;
	/** Whether this provider comes from pi-ai's immutable builtin catalog or Pi config. */
	source: "builtin" | "custom";
	/** Projection of explicit credentials and/or persisted Pi provider config. */
	added: boolean;
	authMethods: ProviderAuthMethod[];
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

function waitForOAuthPrompt(session: OAuthSessionInternal, prompt: AuthPrompt): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const clear = (): void => {
			if (session.resolvePrompt !== resolvePrompt) return;
			session.prompt = undefined;
			session.resolvePrompt = undefined;
			session.rejectPrompt = undefined;
		};
		const settle = (result: { answer: string } | { cause: Error }): void => {
			if (settled) return;
			settled = true;
			prompt.signal?.removeEventListener("abort", abortPrompt);
			clear();
			if ("answer" in result) resolve(result.answer);
			else reject(result.cause);
		};
		const resolvePrompt = (answer: string): void => settle({ answer });
		const rejectPrompt = (cause: Error): void => settle({ cause });
		const abortPrompt = (): void => {
			if (session.status === "waiting_input") session.status = "running";
			rejectPrompt(new DOMException("OAuth prompt cancelled", "AbortError"));
		};

		session.status = "waiting_input";
		session.prompt = {
			type: prompt.type,
			message: prompt.message,
			...("placeholder" in prompt && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
			...(prompt.type === "select" ? { options: prompt.options } : {}),
		};
		session.resolvePrompt = resolvePrompt;
		session.rejectPrompt = rejectPrompt;
		if (prompt.signal?.aborted) abortPrompt();
		else prompt.signal?.addEventListener("abort", abortPrompt, { once: true });
	});
}

export class ProviderCatalog {
	private runtime: Promise<ModelRuntime> | null = null;
	private oauthSessions = new Map<string, OAuthSessionInternal>();
	private readonly piCredentials: EncryptedPiCredentialStore;

	constructor(
		private readonly credentialStore: CredentialStore,
		private readonly agentDir: string,
		private readonly onOAuthChanged: (providerId: string) => void = () => {},
	) {
		this.piCredentials = new EncryptedPiCredentialStore(credentialStore);
	}
	private modelsRecovery: Promise<void> | null = null;

	private async ensureModelsRecovered(): Promise<void> {
		if (!this.modelsRecovery) {
			this.modelsRecovery = this.recoverModelsFile().catch((error) => {
				this.modelsRecovery = null;
				throw error;
			});
		}
		await this.modelsRecovery;
	}

	private async recoverModelsFile(): Promise<void> {
		mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
		const modelsPath = join(this.agentDir, "models.json");
		const result = await recoverDurableFileTransaction({
			root: this.agentDir,
			target: modelsPath,
			verify: async (candidatePath) => {
				await this.validateModelsCandidate(candidatePath);
				return true;
			},
		});
		if (result.status === "recovery-required") {
			throw {
				kind: "conflict",
				reason: "recovery_required",
				details: result,
			};
		}
		if (existsSync(modelsPath)) await this.validateModelsCandidate(modelsPath);
	}

	private async migrateLegacyPiCredentials(): Promise<void> {
		const authPath = join(this.agentDir, "auth.json");
		if (!existsSync(authPath)) return;
		let document: unknown;
		try {
			document = JSON.parse(readFileSync(authPath, "utf8"));
		} catch {
			throw { kind: "conflict", reason: "pi_auth_migration_invalid" };
		}
		if (!isRecord(document)) {
			throw { kind: "conflict", reason: "pi_auth_migration_invalid" };
		}
		const credentials = Object.entries(document);
		for (const [, credential] of credentials) {
			if (!isPiCredential(credential)) {
				throw { kind: "conflict", reason: "pi_auth_migration_invalid" };
			}
		}
		for (const [providerId, credential] of credentials as Array<[string, PiCredential]>) {
			await this.piCredentials.modify(providerId, async (current) => current ?? credential);
		}
		const persisted = await Promise.all(
			credentials.map(async ([providerId]) => {
				const status = await this.credentialStore.getStatus(providerId);
				return status === "stored" || status === "weak_storage";
			}),
		);
		if (persisted.every(Boolean)) {
			try {
				unlinkSync(authPath);
			} catch {
				// The encrypted copy is authoritative; a read-only legacy file is harmless.
			}
		}
	}

	private async validateModelsCandidate(
		candidatePath: string,
		requiredRoutes: readonly { providerId: string; modelId: string }[] = [],
	): Promise<ProviderModelInfoWithProvider[]> {
		const { providers } = readProviderDocument(candidatePath);
		const runtime = await ModelRuntime.create({
			credentials: this.piCredentials,
			modelsPath: candidatePath,
			refreshOnCreate: false,
		});
		const configured = configuredRoutes(providers);
		const projected = new Map<string, ProviderModelInfoWithProvider>();
		for (const route of configured) {
			const model = runtime.getModel(route.providerId, route.modelId);
			if (!model) throw new Error(`Pi did not register ${route.providerId}/${route.modelId}`);
			projected.set(`${route.providerId}\0${route.modelId}`, {
				providerId: route.providerId,
				modelId: model.id,
				name: model.name,
				supportsImages: model.input.includes("image"),
			});
		}
		return requiredRoutes.map((route) => {
			const model = projected.get(`${route.providerId}\0${route.modelId}`);
			if (!model) throw new Error(`Pi did not register ${route.providerId}/${route.modelId}`);
			return model;
		});
	}

	private async replaceModelsDocument(
		document: Record<string, unknown>,
		requiredRoutes: readonly { providerId: string; modelId: string }[] = [],
	): Promise<ProviderModelInfoWithProvider[]> {
		await this.ensureModelsRecovered();
		const modelsPath = join(this.agentDir, "models.json");
		const serialized = `${JSON.stringify(document, null, 2)}\n`;
		let activatedModels: ProviderModelInfoWithProvider[] | undefined;
		await replaceDurableFile({
			root: this.agentDir,
			target: modelsPath,
			stage: (stagingPath) => writeFileSync(stagingPath, serialized, { mode: 0o600 }),
			verify: async (candidatePath) => {
				const models = await this.validateModelsCandidate(candidatePath, requiredRoutes);
				if (candidatePath === modelsPath) activatedModels = models;
				return true;
			},
		});
		this.runtime = null;
		return activatedModels ?? [];
	}

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
		await this.ensureModelsRecovered();
		await this.migrateLegacyPiCredentials();
		return ModelRuntime.create({
			credentials: this.piCredentials,
			modelsPath: join(this.agentDir, "models.json"),
			refreshOnCreate: false,
		});
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
		await this.ensureModelsRecovered();
		const { document, providers } = readProviderDocument(modelsPath);
		const current = providers[input.providerId];
		const currentConfig =
			current && typeof current === "object" && !Array.isArray(current)
				? (current as Record<string, unknown>)
				: {};
		await this.replaceModelsDocument({
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
		});
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
		if (containsCredential(fragment)) {
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

		await this.ensureModelsRecovered();
		const modelsPath = join(this.agentDir, "models.json");
		const { document, providers } = readProviderDocument(modelsPath);
		try {
			return await this.replaceModelsDocument(
				{ ...document, providers: { ...providers, ...fragment.providers } },
				importedRoutes,
			);
		} catch (error) {
			this.runtime = null;
			if (error instanceof DurableFileTransactionError && error.code === "verification-failed") {
				throw { kind: "invalid_request", reason: "pi_model_config_rejected" };
			}
			throw error;
		}
	}

	async overrideProviderBaseUrl(input: { providerId: string; baseUrl: string }): Promise<void> {
		assertAllowedProvider(input.providerId);
		const endpoint = parseHttpEndpoint(input.baseUrl);
		const modelsPath = join(this.agentDir, "models.json");
		await this.ensureModelsRecovered();
		const { document, providers } = readProviderDocument(modelsPath);
		const current = providers[input.providerId];
		const currentConfig =
			current && typeof current === "object" && !Array.isArray(current)
				? (current as Record<string, unknown>)
				: {};
		await this.replaceModelsDocument({
			...document,
			providers: {
				...providers,
				[input.providerId]: {
					...currentConfig,
					baseUrl: endpoint.toString().replace(/\/$/, ""),
				},
			},
		});
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
				authMethods: [
					...(provider.auth.apiKey
						? [{ type: "api_key" as const, name: provider.auth.apiKey.name }]
						: []),
					...(provider.auth.oauth
						? [
								{
									type: "oauth" as const,
									name: provider.auth.oauth.name,
									...(provider.auth.oauth.loginLabel
										? { loginLabel: provider.auth.oauth.loginLabel }
										: {}),
									...(provider.auth.oauth.isSubscription !== undefined
										? { isSubscription: provider.auth.oauth.isSubscription }
										: {}),
								},
							]
						: []),
				],
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

	/** Persist an API key in Pi's runtime and encrypted credential backend. */
	async setApiKey(providerId: string, apiKey: string, sessionOnly?: boolean): Promise<void> {
		assertAllowedProvider(providerId);
		const runtime = await this.getRuntime();
		if (!runtime.getProvider(providerId)) {
			throw { kind: "not_found", reason: `provider_not_found: ${providerId}` };
		}
		this.piCredentials.setSessionOnly(providerId, sessionOnly === true);
		try {
			await runtime.setRuntimeApiKey(providerId, apiKey);
			await this.piCredentials.modify(providerId, async () => ({
				type: "api_key",
				key: apiKey,
			}));
		} catch (error) {
			throw toHostError(error, providerId);
		} finally {
			this.piCredentials.setSessionOnly(providerId, false);
		}
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
		await this.piCredentials.delete(providerId);

		const modelsPath = join(this.agentDir, "models.json");
		if (existsSync(modelsPath)) {
			const { document, providers } = readProviderDocument(modelsPath);
			if (Object.hasOwn(providers, providerId)) {
				const remainingProviders = { ...providers };
				delete remainingProviders[providerId];
				await this.replaceModelsDocument({ ...document, providers: remainingProviders });
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
		await this.piCredentials.delete(providerId);
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
		const isCurrent = () =>
			this.oauthSessions.get(providerId) === session && !session.abort?.signal.aborted;
		const changed = () => {
			if (isCurrent()) this.onOAuthChanged(providerId);
		};
		void this.loginOAuth(providerId, {
			signal: session.abort.signal,
			notify: (event) => {
				if (!isCurrent()) return;
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
				changed();
			},
			prompt: (prompt) => {
				if (!isCurrent())
					return Promise.reject(new DOMException("OAuth session retired", "AbortError"));
				const answer = waitForOAuthPrompt(session, prompt);
				changed();
				return answer;
			},
		})
			.then((result) => {
				if (!isCurrent()) return;
				Object.assign(session, result);
				session.status = "completed";
				session.message = undefined;
				session.infoLinks = undefined;
				session.prompt = undefined;
				session.resolvePrompt = undefined;
				session.rejectPrompt = undefined;
				changed();
			})
			.catch((cause) => {
				if (!isCurrent()) return;
				session.status = "failed";
				session.prompt = undefined;
				session.resolvePrompt = undefined;
				session.rejectPrompt = undefined;
				session.message = oauthFailureReason(cause);
				changed();
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
