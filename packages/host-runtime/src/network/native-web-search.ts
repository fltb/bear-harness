import type { Api, AuthResult, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Run provider-hosted search outside the owning Pi AgentSession, then return
 * normalized evidence through an ordinary Pi tool result. Provider-native
 * server blocks must never enter the main transcript because they cannot be
 * replayed after a cross-provider model switch.
 */

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ANSWER_CHARACTERS = 24_000;
const MAX_SNIPPET_CHARACTERS = 600;
const SEARCH_TIMEOUT_MS = 60_000;
const SEARCH_SYSTEM_PROMPT =
	"Search the public web for the user's query. Return a concise factual answer grounded in the search results and cite the source URLs.";

export const NATIVE_WEB_SEARCH_PROVIDER_IDS = [
	"anthropic",
	"deepseek",
	"google",
	"openai",
	"openai-codex",
	"xai",
] as const;

export type NativeWebSearchProviderId = (typeof NATIVE_WEB_SEARCH_PROVIDER_IDS)[number];

export interface NativeWebSearchSource {
	title: string;
	url: string;
	snippet?: string;
}

export interface NativeWebSearchResult {
	providerId: NativeWebSearchProviderId;
	modelId: string;
	answer?: string;
	sources: NativeWebSearchSource[];
	searchQueries?: string[];
}

export interface NativeWebSearchInput {
	models: Pick<ModelRuntime, "getAuth" | "isUsingOAuth">;
	model: Model<Api>;
	query: string;
	limit: number;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
}

export class NativeWebSearchError extends Error {
	constructor(
		readonly code: string,
		message = code,
		readonly status?: number,
	) {
		super(message);
		this.name = "NativeWebSearchError";
	}
}

export function supportsNativeWebSearch(
	providerId: string,
): providerId is NativeWebSearchProviderId {
	return (NATIVE_WEB_SEARCH_PROVIDER_IDS as readonly string[]).includes(providerId);
}

/** Conservative exposure policy: known model families on the native provider
 * transport. OpenAI-compatible gateways do not imply hosted search support.
 * Keep account/auth availability out of this check: those are request errors.
 * Provider protocol references are listed in docs/native-web-search-protocol.md.
 */
export function modelSupportsNativeWebSearch(model: Model<Api> | undefined): boolean {
	if (!model) return false;
	const policies: Record<string, { api: string; origin: string; models: RegExp }> = {
		openai: {
			api: "openai-responses",
			origin: "https://api.openai.com",
			models: /^(?:gpt-(?:4\.1|4o|5|6)(?:[.-]|$)|o[34](?:-|$))/u,
		},
		"openai-codex": {
			api: "openai-codex-responses",
			origin: "https://chatgpt.com",
			models: /^gpt-(?:5|6)(?:[.-]|$)/u,
		},
		anthropic: {
			api: "anthropic-messages",
			origin: "https://api.anthropic.com",
			models: /^claude-(?:(?:sonnet|opus|haiku)-[45]|3-[57]-sonnet)/u,
		},
		deepseek: {
			api: "openai-completions",
			origin: "https://api.deepseek.com",
			models: /^deepseek-(?:v4-(?:flash|pro)|flash)(?:-|$)/u,
		},
		google: {
			api: "google-generative-ai",
			origin: "https://generativelanguage.googleapis.com",
			models: /^gemini-(?:2\.5|3(?:\.\d+)?)-(?:flash|pro)(?:-|$)/u,
		},
		xai: { api: "openai-responses", origin: "https://api.x.ai", models: /^grok-4(?:[.-]|$)/u },
	};
	const policy = policies[model.provider];
	if (!policy || model.api !== policy.api || !policy.models.test(model.id)) return false;
	if (/(?:nano|image|audio|realtime|embedding|search-api|deep-research)/u.test(model.id))
		return false;
	try {
		return new URL(model.baseUrl).origin === policy.origin;
	} catch {
		return false;
	}
}

export function formatNativeWebSearchResult(result: NativeWebSearchResult): string {
	const lines: string[] = [];
	if (result.answer) lines.push(result.answer);
	if (result.sources.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(`Sources (${result.sources.length}):`);
		for (const [index, source] of result.sources.entries()) {
			lines.push(`${index + 1}. ${source.title}`);
			lines.push(`   ${source.url}`);
			if (source.snippet) lines.push(`   ${source.snippet}`);
		}
	}
	return lines.join("\n") || "The provider completed web search but returned no readable text.";
}

export async function searchNativeWeb(input: NativeWebSearchInput): Promise<NativeWebSearchResult> {
	if (!supportsNativeWebSearch(input.model.provider)) {
		throw new NativeWebSearchError(
			"native_web_search_provider_unsupported",
			`The current provider does not expose native web search: ${input.model.provider}`,
		);
	}
	const usingOAuth = input.models.isUsingOAuth(input.model.provider);
	const auth = await input.models.getAuth(input.model, {
		signal: input.signal,
		minOAuthValidityMs: 5 * 60_000,
	});
	if (!auth) {
		throw new NativeWebSearchError(
			"native_web_search_auth_required",
			`The current provider is not authenticated: ${input.model.provider}`,
		);
	}

	const request = {
		...input,
		// One total deadline includes Messages pause_turn continuations.
		signal: requestSignal(input.signal),
		providerId: input.model.provider,
		auth,
		usingOAuth,
		fetch: input.fetch ?? globalThis.fetch,
	};
	assertSafeOAuthEndpoint(request);
	switch (request.providerId) {
		case "anthropic":
			return searchAnthropic(request);
		case "deepseek":
			return searchDeepSeek(request);
		case "google":
			return searchGoogle(request);
		case "openai-codex":
			return searchCodex(request);
		case "openai":
		case "xai":
			return searchResponses(request);
	}
}

type ResolvedSearchInput = NativeWebSearchInput & {
	providerId: NativeWebSearchProviderId;
	auth: AuthResult;
	usingOAuth: boolean;
	fetch: typeof globalThis.fetch;
};

const OFFICIAL_OAUTH_ORIGINS: Partial<Record<NativeWebSearchProviderId, string>> = {
	anthropic: "https://api.anthropic.com",
	"openai-codex": "https://chatgpt.com",
	xai: "https://api.x.ai",
};

function providerBaseUrl(input: ResolvedSearchInput): string {
	const value = input.auth.auth.baseUrl ?? input.model.baseUrl;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new NativeWebSearchError("native_web_search_endpoint_invalid");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new NativeWebSearchError("native_web_search_endpoint_invalid");
	}
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/u, "");
}

function assertSafeOAuthEndpoint(input: ResolvedSearchInput): void {
	if (!input.usingOAuth) return;
	const expectedOrigin = OFFICIAL_OAUTH_ORIGINS[input.providerId];
	if (!expectedOrigin) return;
	if (new URL(providerBaseUrl(input)).origin !== expectedOrigin) {
		throw new NativeWebSearchError("native_web_search_oauth_endpoint_untrusted");
	}
}

function endpoint(baseUrl: string, suffix: string): string {
	return `${baseUrl.replace(/\/+$/u, "")}/${suffix.replace(/^\/+/, "")}`;
}

function responseEndpoint(input: ResolvedSearchInput): string {
	const baseUrl = providerBaseUrl(input);
	return baseUrl.endsWith("/responses") ? baseUrl : endpoint(baseUrl, "responses");
}

function codexEndpoint(input: ResolvedSearchInput): string {
	const baseUrl = providerBaseUrl(input);
	if (baseUrl.endsWith("/codex/responses")) return baseUrl;
	if (baseUrl.endsWith("/codex")) return endpoint(baseUrl, "responses");
	return endpoint(baseUrl, "codex/responses");
}

function anthropicEndpoint(input: ResolvedSearchInput): string {
	if (providerBaseUrl(input).endsWith("/v1/messages")) return providerBaseUrl(input);
	const baseUrl = providerBaseUrl(input).replace(/\/v1$/u, "");
	return endpoint(baseUrl, "v1/messages");
}

function deepSeekEndpoint(input: ResolvedSearchInput): string {
	const baseUrl = providerBaseUrl(input);
	if (baseUrl.endsWith("/anthropic/v1/messages")) return baseUrl;
	if (baseUrl.endsWith("/anthropic/v1")) return endpoint(baseUrl, "messages");
	if (baseUrl.endsWith("/anthropic")) return endpoint(baseUrl, "v1/messages");
	return endpoint(baseUrl.replace(/\/v1$/u, ""), "anthropic/v1/messages");
}

function googleEndpoint(input: ResolvedSearchInput): string {
	const baseUrl = providerBaseUrl(input);
	return endpoint(baseUrl, `models/${encodeURIComponent(input.model.id)}:generateContent`);
}

function commonHeaders(input: ResolvedSearchInput): Headers {
	const headers = new Headers();
	applyHeaders(headers, input.model.headers);
	applyHeaders(headers, input.auth.auth.headers);
	headers.set("Accept", "application/json");
	headers.set("Content-Type", "application/json");
	return headers;
}

function applyHeaders(headers: Headers, values: Record<string, string | null> | undefined): void {
	for (const [key, value] of Object.entries(values ?? {})) {
		if (value === null) headers.delete(key);
		else headers.set(key, value);
	}
}

function requireApiKey(input: ResolvedSearchInput): string {
	const key = input.auth.auth.apiKey?.trim();
	if (!key) throw new NativeWebSearchError("native_web_search_auth_required");
	return key;
}

function applyBearerAuth(headers: Headers, input: ResolvedSearchInput): string | undefined {
	const key = input.auth.auth.apiKey?.trim();
	if (key) headers.set("Authorization", `Bearer ${key}`);
	if (!headers.has("Authorization")) {
		throw new NativeWebSearchError("native_web_search_auth_required");
	}
	return key;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function post(
	input: ResolvedSearchInput,
	url: string,
	headers: Headers,
	body: unknown,
): Promise<Response> {
	let response: Response;
	try {
		response = await input.fetch(url, {
			method: "POST",
			redirect: "error",
			headers,
			body: JSON.stringify(body),
			signal: requestSignal(input.signal),
		});
	} catch (error) {
		if (input.signal?.aborted) throw error;
		throw new NativeWebSearchError(
			"native_web_search_transport_failed",
			error instanceof Error ? error.message : "Native web search request failed",
		);
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new NativeWebSearchError(
			"native_web_search_http_error",
			`Native web search request failed with HTTP ${response.status}`,
			response.status,
		);
	}
	return response;
}

async function readLimitedText(response: Response): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
		await response.body?.cancel().catch(() => undefined);
		throw new NativeWebSearchError("native_web_search_response_too_large");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new NativeWebSearchError("native_web_search_response_too_large");
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	const text = await readLimitedText(response);
	try {
		const value = JSON.parse(text) as unknown;
		if (!isRecord(value)) throw new Error("response is not an object");
		return value;
	} catch {
		throw new NativeWebSearchError("native_web_search_response_invalid");
	}
}

/** Protocol checked 2026-09-20.
 * OpenAI: https://developers.openai.com/api/docs/guides/tools-web-search
 * xAI: https://docs.x.ai/developers/tools/web-search
 * xAI citations: https://docs.x.ai/developers/tools/citations
 * Both use POST /v1/responses with tools:[{type:"web_search"}]. Only OpenAI
 * requests action.sources; xAI documents output[].content[].annotations.
 */
async function searchResponses(input: ResolvedSearchInput): Promise<NativeWebSearchResult> {
	const headers = commonHeaders(input);
	applyBearerAuth(headers, input);
	const webSearchTool: Record<string, unknown> = { type: "web_search" };
	const body: Record<string, unknown> = {
		model: input.model.id,
		store: false,
		input: [
			{ role: "system", content: SEARCH_SYSTEM_PROMPT },
			{ role: "user", content: input.query },
		],
		tools: [webSearchTool],
	};
	if (input.providerId === "openai") {
		body.include = ["web_search_call.action.sources"];
		body.tool_choice = { type: "web_search" };
	}

	const response = await post(input, responseEndpoint(input), headers, body);
	const parsed = parseResponsesResult(await readJson(response), input.limit);
	if (!parsed.searchInvoked) {
		throw new NativeWebSearchError("native_web_search_not_invoked");
	}
	const result: NativeWebSearchResult = {
		providerId: input.providerId as "openai" | "xai",
		modelId: stringValue(parsed.response.model) ?? input.model.id,
		answer: boundedText(parsed.answer, MAX_ANSWER_CHARACTERS),
		sources: parsed.sources,
	};
	return requireReadableResult(result);
}

/** Public event schema: https://developers.openai.com/api/reference/resources/responses/streaming-events
 * The ChatGPT /backend-api/codex endpoint is NOT a documented public API.
 * Its auth headers and response.done variant follow installed Pi 0.85.1's
 * api/openai-codex-responses implementation, not a public API guarantee.
 */
async function searchCodex(input: ResolvedSearchInput): Promise<NativeWebSearchResult> {
	const accessToken = requireApiKey(input);
	const headers = commonHeaders(input);
	applyBearerAuth(headers, input);
	const accountId = codexAccountId(accessToken, input.usingOAuth);
	if (accountId) headers.set("chatgpt-account-id", accountId);
	else headers.delete("chatgpt-account-id");
	headers.set("originator", "pi");
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("Accept", "text/event-stream");
	headers.set("User-Agent", "bear-harness/1.0");

	const response = await post(input, codexEndpoint(input), headers, {
		model: input.model.id,
		stream: true,
		store: false,
		instructions: SEARCH_SYSTEM_PROMPT,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: input.query }],
			},
		],
		tools: [{ type: "web_search", search_context_size: "high" }],
		tool_choice: { type: "web_search" },
		include: ["web_search_call.action.sources"],
		parallel_tool_calls: true,
	});

	const events = parseSse(await readLimitedText(response));
	const finalObjects: Record<string, unknown>[] = [];
	const deltas: string[] = [];
	let modelId = input.model.id;
	let searchInvoked = false;
	let completed = false;
	for (const event of events) {
		const eventType = stringValue(event.type) ?? "";
		if (eventType.startsWith("response.web_search_call")) searchInvoked = true;
		if (eventType === "response.output_text.delta") {
			const delta = stringValue(event.delta);
			if (delta) deltas.push(delta);
		}
		if (eventType === "response.output_item.done" && isRecord(event.item)) {
			finalObjects.push(event.item);
			if (event.item.type === "web_search_call") searchInvoked = true;
		}
		if (
			(eventType === "response.completed" || eventType === "response.done") &&
			isRecord(event.response)
		) {
			assertResponsesCompleted(event.response);
			completed = true;
			modelId = stringValue(event.response.model) ?? modelId;
			// Terminal output repeats output_item.done; use it as the authority.
			if (recordArray(event.response.output).length > 0) {
				finalObjects.splice(0, finalObjects.length, ...recordArray(event.response.output));
			}
		}
		if (
			eventType === "error" ||
			eventType === "response.failed" ||
			eventType === "response.incomplete"
		) {
			throw new NativeWebSearchError("native_web_search_provider_failed");
		}
	}
	if (!completed) throw new NativeWebSearchError("native_web_search_stream_incomplete");
	const parsed = parseResponsesOutput(finalObjects, input.limit);
	if (!searchInvoked && !parsed.searchInvoked) {
		throw new NativeWebSearchError("native_web_search_not_invoked");
	}
	return requireReadableResult({
		providerId: "openai-codex",
		modelId,
		answer: boundedText(parsed.answer || deltas.join(""), MAX_ANSWER_CHARACTERS),
		sources: parsed.sources,
	});
}

/** https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
 * Basic search uses web_search_20250305; max_uses caps searches, not source count.
 * HTTP 200 may contain a tool error. pause_turn must replay encrypted blocks
 * unchanged inside this isolated request only. OAuth details are Pi-specific.
 */
async function searchAnthropic(input: ResolvedSearchInput): Promise<NativeWebSearchResult> {
	const apiKey = input.auth.auth.apiKey?.trim();
	const oauth = input.usingOAuth;
	const headers = commonHeaders(input);
	headers.set("anthropic-version", "2023-06-01");
	appendHeaderTokens(
		headers,
		"anthropic-beta",
		oauth
			? ["claude-code-20250219", "oauth-2025-04-20", "web-search-2025-03-05"]
			: ["web-search-2025-03-05"],
	);
	if (oauth) {
		if (!apiKey) throw new NativeWebSearchError("native_web_search_auth_required");
		headers.set("Authorization", `Bearer ${apiKey}`);
		headers.set("User-Agent", "claude-cli/2.1.251");
		headers.set("x-app", "cli");
	} else if (apiKey) {
		headers.set("x-api-key", apiKey);
	} else if (!headers.has("Authorization") && !headers.has("x-api-key")) {
		throw new NativeWebSearchError("native_web_search_auth_required");
	}

	const system = oauth
		? [
				{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
				{ type: "text", text: SEARCH_SYSTEM_PROMPT },
			]
		: SEARCH_SYSTEM_PROMPT;
	const json = await postMessagesSearch(input, anthropicEndpoint(input), headers, {
		model: input.model.id,
		max_tokens: 4096,
		system,
		messages: [{ role: "user", content: input.query }],
		tools: [
			{
				type: "web_search_20250305",
				name: "web_search",
				max_uses: Math.min(5, Math.max(1, input.limit)),
			},
		],
	});
	const parsed = parseAnthropicSearchContent(json, input.limit);
	if (!parsed.resultBlockSeen) throw new NativeWebSearchError("native_web_search_not_invoked");
	return requireReadableResult({
		providerId: "anthropic",
		modelId: stringValue(json.model) ?? input.model.id,
		answer: boundedText(parsed.answers.join("\n\n"), MAX_ANSWER_CHARACTERS),
		sources: parsed.sources,
		searchQueries: parsed.searchQueries.length > 0 ? parsed.searchQueries : undefined,
	});
}

/** https://api-docs.deepseek.com/guides/anthropic_api/
 * https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-search-deepseek/src/provider.ts
 * The official harness specifies Messages + web_search_20250305 and shared API
 * key. https://api-docs.deepseek.com/guides/responses_api/ says Responses built-in
 * tools are ignored. Do not infer search support from Chat Completions alone.
 */
async function searchDeepSeek(input: ResolvedSearchInput): Promise<NativeWebSearchResult> {
	const apiKey = requireApiKey(input);
	const headers = commonHeaders(input);
	headers.set("x-api-key", apiKey);
	headers.set("Authorization", `Bearer ${apiKey}`);
	headers.set("anthropic-version", "2023-06-01");
	headers.set("User-Agent", "bear-harness/1.0");

	const json = await postMessagesSearch(input, deepSeekEndpoint(input), headers, {
		model: input.model.id,
		max_tokens: 4096,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: `Perform a web search for the query: ${input.query}` }],
			},
		],
		tools: [
			{
				type: "web_search_20250305",
				name: "web_search",
				max_uses: Math.min(5, Math.max(1, input.limit)),
			},
		],
	});
	const parsed = parseAnthropicSearchContent(json, input.limit, true);
	if (!parsed.resultBlockSeen) {
		throw new NativeWebSearchError("native_web_search_not_invoked");
	}
	return requireReadableResult({
		providerId: "deepseek",
		modelId: stringValue(json.model) ?? input.model.id,
		answer: boundedText(parsed.answers.join("\n\n"), MAX_ANSWER_CHARACTERS),
		sources: parsed.sources,
		searchQueries: parsed.searchQueries.length > 0 ? parsed.searchQueries : undefined,
	});
}

async function postMessagesSearch(
	input: ResolvedSearchInput,
	url: string,
	headers: Headers,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const messages = recordArray(body.messages);
	const content: Record<string, unknown>[] = [];
	// Bounded continuation; this is auxiliary provider data, never Pi state.
	for (let attempt = 0; attempt < 3; attempt++) {
		const json = await readJson(await post(input, url, headers, { ...body, messages }));
		if (json.type === "error") throw new NativeWebSearchError("native_web_search_provider_failed");
		content.push(...recordArray(json.content));
		if (json.stop_reason !== "pause_turn") {
			if (json.stop_reason === "max_tokens" || json.stop_reason === "refusal")
				throw new NativeWebSearchError("native_web_search_provider_failed");
			return { ...json, content };
		}
		messages.push({ role: "assistant", content: json.content });
	}
	throw new NativeWebSearchError("native_web_search_continuation_limit");
}

function parseAnthropicSearchContent(
	json: Record<string, unknown>,
	limit: number,
	answerAfterLastResult = true,
): {
	answers: string[];
	sources: NativeWebSearchSource[];
	searchQueries: string[];
	searchInvoked: boolean;
	resultBlockSeen: boolean;
} {
	const blocks = recordArray(json.content);
	const sources: NativeWebSearchSource[] = [];
	const seen = new Set<string>();
	const answers: string[] = [];
	const searchQueries: string[] = [];
	let searchInvoked = false;
	let resultBlockSeen = false;
	let lastResultIndex = -1;
	for (const [index, block] of blocks.entries()) {
		if (block.type === "web_search_tool_result") lastResultIndex = index;
	}
	for (const [index, block] of blocks.entries()) {
		if (block.type === "server_tool_use" && block.name === "web_search") {
			searchInvoked = true;
			if (isRecord(block.input)) {
				const query = stringValue(block.input.query);
				if (query) searchQueries.push(query);
			}
		}
		if (block.type === "web_search_tool_result") {
			// Official schema: content is either result[] or a single error object.
			if (isRecord(block.content) && block.content.type === "web_search_tool_result_error")
				throw new NativeWebSearchError("native_web_search_provider_failed");
			searchInvoked = true;
			resultBlockSeen = true;
			for (const item of recordArray(block.content)) {
				if (item.type !== "web_search_result") continue;
				addSource(sources, seen, item.url, item.title, undefined, limit);
			}
		}
		if (block.type === "text") {
			const text = stringValue(block.text);
			if (text && (!answerAfterLastResult || index > lastResultIndex)) answers.push(text);
			for (const citation of recordArray(block.citations)) {
				addSource(sources, seen, citation.url, citation.title, citation.cited_text, limit);
			}
		}
	}
	return { answers, sources, searchQueries, searchInvoked, resultBlockSeen };
}

/** generateContent REST schema (not the separate Interactions API):
 * https://ai.google.dev/api/generate-content#GroundingMetadata
 * https://ai.google.dev/api/generate-content#GroundingSupport
 * googleSearch enables grounding; queries/chunks prove it ran. Support indices
 * address the original groundingChunks array, not the deduplicated sources.
 */
async function searchGoogle(input: ResolvedSearchInput): Promise<NativeWebSearchResult> {
	const headers = commonHeaders(input);
	headers.set("x-goog-api-key", requireApiKey(input));
	const response = await post(input, googleEndpoint(input), headers, {
		systemInstruction: { parts: [{ text: SEARCH_SYSTEM_PROMPT }] },
		contents: [{ role: "user", parts: [{ text: input.query }] }],
		tools: [{ googleSearch: {} }],
		generationConfig: { maxOutputTokens: 4096 },
	});
	const json = await readJson(response);
	const answers: string[] = [];
	const sources: NativeWebSearchSource[] = [];
	const queries: string[] = [];
	const seen = new Set<string>();
	let searchInvoked = false;
	for (const candidate of recordArray(json.candidates)) {
		if (candidate.finishReason && candidate.finishReason !== "STOP")
			throw new NativeWebSearchError("native_web_search_provider_failed");
		if (isRecord(candidate.content)) {
			for (const part of recordArray(candidate.content.parts)) {
				const text = stringValue(part.text);
				if (text && part.thought !== true) answers.push(text);
			}
		}
		if (!isRecord(candidate.groundingMetadata)) continue;
		searchInvoked ||=
			stringArray(candidate.groundingMetadata.webSearchQueries).length > 0 ||
			recordArray(candidate.groundingMetadata.groundingChunks).some((chunk) => isRecord(chunk.web));
		for (const query of stringArray(candidate.groundingMetadata.webSearchQueries))
			queries.push(query);
		const chunks = candidate.groundingMetadata.groundingChunks;
		const chunkSources = (Array.isArray(chunks) ? chunks : []).map((chunk: unknown) =>
			isRecord(chunk) && isRecord(chunk.web)
				? addSource(sources, seen, chunk.web.uri, chunk.web.title, undefined, input.limit)
				: undefined,
		);
		for (const support of recordArray(candidate.groundingMetadata.groundingSupports)) {
			if (!isRecord(support.segment)) continue;
			const snippet = stringValue(support.segment.text);
			for (const index of numberArray(support.groundingChunkIndices)) {
				const source = chunkSources[index];
				if (source && snippet && !source.snippet)
					source.snippet = boundedText(snippet, MAX_SNIPPET_CHARACTERS);
			}
		}
	}
	if (!searchInvoked) throw new NativeWebSearchError("native_web_search_not_invoked");
	return requireReadableResult({
		providerId: "google",
		modelId: stringValue(json.modelVersion) ?? input.model.id,
		answer: boundedText(answers.join("\n\n"), MAX_ANSWER_CHARACTERS),
		sources,
		searchQueries: queries.length > 0 ? queries : undefined,
	});
}

function parseResponsesResult(
	response: Record<string, unknown>,
	limit: number,
): ReturnType<typeof parseResponsesOutput> & { response: Record<string, unknown> } {
	assertResponsesCompleted(response);
	const output = recordArray(response.output);
	const parsed = parseResponsesOutput(output, limit);
	// output_text is an SDK convenience, not a raw HTTP response field.
	return { ...parsed, response };
}

function assertResponsesCompleted(response: Record<string, unknown>): void {
	if (response.error || (response.status && response.status !== "completed"))
		throw new NativeWebSearchError("native_web_search_provider_failed");
}

function parseResponsesOutput(
	output: Record<string, unknown>[],
	limit: number,
): { answer: string; sources: NativeWebSearchSource[]; searchInvoked: boolean } {
	const answers: string[] = [];
	const sources: NativeWebSearchSource[] = [];
	const seen = new Set<string>();
	let searchInvoked = false;
	for (const item of output) {
		if (item.type === "web_search_call" && item.status && item.status !== "completed")
			throw new NativeWebSearchError("native_web_search_provider_failed");
		if (item.type === "web_search_call") {
			searchInvoked = true;
			if (isRecord(item.action))
				collectResponseSourceGroup(sources, seen, item.action.sources, limit);
		}
		if (item.type !== "message") continue;
		for (const part of recordArray(item.content)) {
			if (part.type === "output_text") {
				const text = stringValue(part.text);
				if (text) answers.push(text);
				for (const annotation of recordArray(part.annotations)) {
					if (annotation.type !== "url_citation") continue;
					searchInvoked = true;
					addSource(sources, seen, annotation.url, annotation.title, undefined, limit);
				}
			}
		}
	}
	return { answer: answers.join("\n\n"), sources, searchInvoked };
}

function collectResponseSourceGroup(
	sources: NativeWebSearchSource[],
	seen: Set<string>,
	value: unknown,
	limit: number,
): void {
	for (const source of recordArray(value)) {
		addSource(
			sources,
			seen,
			source.url ?? source.source_website_url,
			source.title ?? source.caption,
			source.snippet,
			limit,
		);
	}
}

function addSource(
	sources: NativeWebSearchSource[],
	seen: Set<string>,
	urlValue: unknown,
	titleValue: unknown,
	snippetValue: unknown,
	limit: number,
): NativeWebSearchSource | undefined {
	const url = safeSourceUrl(urlValue);
	if (!url) return undefined;
	if (seen.has(url)) {
		const existing = sources.find((source) => source.url === url);
		if (!existing) return undefined;
		const title = boundedText(stringValue(titleValue)?.trim(), 500);
		const snippet = boundedText(stringValue(snippetValue), MAX_SNIPPET_CHARACTERS);
		if (title && existing.title === url) existing.title = title;
		if (snippet && !existing.snippet) existing.snippet = snippet;
		return existing;
	}
	if (sources.length >= limit) return undefined;
	seen.add(url);
	const title = boundedText(stringValue(titleValue)?.trim() || url, 500) ?? url;
	const snippet = boundedText(stringValue(snippetValue), MAX_SNIPPET_CHARACTERS);
	const source = { title, url, ...(snippet ? { snippet } : {}) };
	sources.push(source);
	return source;
}

function safeSourceUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		url.username = "";
		url.password = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

function appendHeaderTokens(headers: Headers, name: string, additions: string[]): void {
	const tokens = new Set(
		(headers.get(name) ?? "")
			.split(",")
			.map((token) => token.trim())
			.filter(Boolean),
	);
	for (const addition of additions) tokens.add(addition);
	headers.set(name, [...tokens].join(","));
}

function parseSse(text: string): Record<string, unknown>[] {
	const events: Record<string, unknown>[] = [];
	for (const block of text.split(/\r?\n\r?\n/u)) {
		const data = block
			.split(/\r?\n/u)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") continue;
		try {
			const value = JSON.parse(data) as unknown;
			if (isRecord(value)) events.push(value);
		} catch {
			throw new NativeWebSearchError("native_web_search_response_invalid");
		}
	}
	return events;
}

function codexAccountId(token: string, required: boolean): string | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) throw new Error("JWT payload missing");
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
		if (!isRecord(decoded)) throw new Error("JWT payload invalid");
		const auth = decoded["https://api.openai.com/auth"];
		if (!isRecord(auth)) throw new Error("JWT auth claim missing");
		const accountId = stringValue(auth.chatgpt_account_id);
		if (!accountId) throw new Error("account id missing");
		return accountId;
	} catch {
		if (required) throw new NativeWebSearchError("native_web_search_codex_account_missing");
		return undefined;
	}
}

function requireReadableResult(result: NativeWebSearchResult): NativeWebSearchResult {
	if (!result.answer && result.sources.length === 0) {
		throw new NativeWebSearchError("native_web_search_response_empty");
	}
	return result;
}

function boundedText(value: string | undefined, maximum: number): string | undefined {
	const text = value?.trim();
	if (!text) return undefined;
	return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordArray(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function numberArray(value: unknown): number[] {
	return Array.isArray(value) ? value.filter((item): item is number => Number.isInteger(item)) : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
