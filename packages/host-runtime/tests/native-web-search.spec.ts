// @vitest-environment node

import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { registerHostTools } from "../src/companion/host-tool-register.js";
import {
	formatNativeWebSearchResult,
	modelSupportsNativeWebSearch,
	NativeWebSearchError,
	searchNativeWeb,
} from "../src/network/native-web-search.js";

function model(provider: string, id = "search-model", baseUrl = `https://${provider}.example/v1`) {
	return {
		provider,
		id,
		name: id,
		api: provider === "google" ? "google-generative-ai" : "openai-responses",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	} as Model<Api>;
}

function runtime(
	auth: { apiKey?: string; headers?: Record<string, string> } = { apiKey: "secret" },
	usingOAuth = false,
) {
	return {
		getAuth: vi.fn(async () => ({ auth })),
		isUsingOAuth: vi.fn(() => usingOAuth),
	};
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("native search exposure", () => {
	it.each([
		["openai", "gpt-5.4", "https://api.openai.com/v1", "openai-responses", true],
		["openai", "gpt-5-nano", "https://api.openai.com/v1", "openai-responses", false],
		["openai", "gpt-3.5-turbo", "https://api.openai.com/v1", "openai-responses", false],
		["openai", "gpt-5.4", "https://gateway.example/v1", "openai-responses", false],
		["openrouter", "gpt-5.4", "https://api.openai.com/v1", "openai-responses", false],
		[
			"openai-codex",
			"gpt-5.6-sol",
			"https://chatgpt.com/backend-api",
			"openai-codex-responses",
			true,
		],
		["deepseek", "deepseek-v4-flash", "https://api.deepseek.com", "openai-completions", true],
		["deepseek", "deepseek-v4-flash", "https://api.deepseek.com", "openai-responses", false],
		[
			"google",
			"gemini-2.5-flash",
			"https://generativelanguage.googleapis.com/v1beta",
			"google-generative-ai",
			true,
		],
		["anthropic", "claude-sonnet-4-5", "https://api.anthropic.com", "anthropic-messages", true],
		["xai", "grok-4", "https://api.x.ai/v1", "openai-responses", true],
	])("%s / %s at %s (%s): %s", (provider, id, baseUrl, api, expected) => {
		expect(
			modelSupportsNativeWebSearch({
				...model(String(provider), String(id), String(baseUrl)),
				api,
			} as Model<Api>),
		).toBe(expected);
	});
});

describe("native provider web search", () => {
	// Protocol references and limitations: docs/native-web-search-protocol.md.
	// These are synthetic protocol examples, not captured live provider responses.
	it("uses OpenAI's hosted tool and normalizes cited sources", async () => {
		const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
			jsonResponse({
				model: "gpt-search",
				output: [
					{
						type: "web_search_call",
						action: {
							sources: [{ title: "Primary", url: "https://example.com/primary" }],
						},
					},
					{
						type: "message",
						content: [
							{
								type: "output_text",
								text: "Grounded answer",
								annotations: [
									{
										type: "url_citation",
										title: "Second",
										url: "https://example.com/second",
										start_index: 0,
										end_index: 14,
									},
								],
							},
						],
					},
				],
			}),
		);

		const result = await searchNativeWeb({
			models: runtime(),
			model: model("openai", "gpt-search", "https://api.openai.com/v1"),
			query: "latest release",
			limit: 8,
			fetch,
		});

		expect(result).toEqual({
			providerId: "openai",
			modelId: "gpt-search",
			answer: "Grounded answer",
			sources: [
				{ title: "Primary", url: "https://example.com/primary" },
				{ title: "Second", url: "https://example.com/second" },
			],
		});
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe("https://api.openai.com/v1/responses");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			tools: [{ type: "web_search" }],
			tool_choice: { type: "web_search" },
		});
	});

	it("uses Codex OAuth without exposing server tool blocks to the main transcript", async () => {
		const token = [
			Buffer.from("{}").toString("base64url"),
			Buffer.from(
				JSON.stringify({
					"https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
				}),
			).toString("base64url"),
			"signature",
		].join(".");
		const sse = [
			{ type: "response.created", response: { id: "response-1", model: "gpt-5.6-sol" } },
			{ type: "response.web_search_call.completed", item_id: "search-1" },
			{
				type: "response.output_item.done",
				item: {
					type: "web_search_call",
					action: { sources: [{ title: "Codex source", url: "https://example.com/codex" }] },
				},
			},
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					content: [{ type: "output_text", text: "Codex answer" }],
				},
			},
			{ type: "response.completed", response: { model: "gpt-5.6-sol", output: [] } },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("");
		const fetch = vi.fn(
			async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
		);

		const result = await searchNativeWeb({
			models: runtime({ apiKey: token }, true),
			model: model("openai-codex", "gpt-5.6-sol", "https://chatgpt.com/backend-api"),
			query: "release status",
			limit: 5,
			fetch,
		});

		expect(result).toMatchObject({
			providerId: "openai-codex",
			modelId: "gpt-5.6-sol",
			answer: "Codex answer",
			sources: [{ title: "Codex source", url: "https://example.com/codex" }],
		});
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("account-1");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			stream: true,
			tools: [{ type: "web_search" }],
		});
	});

	it("uses Anthropic's server-managed search and returns ordinary source data", async () => {
		const fetch = vi.fn(async () =>
			jsonResponse({
				id: "message-1",
				model: "claude-sonnet",
				content: [
					{ type: "server_tool_use", name: "web_search", input: { query: "bear release" } },
					{
						type: "web_search_tool_result",
						content: [
							{
								type: "web_search_result",
								title: "Anthropic source",
								url: "https://example.com/anthropic",
							},
						],
					},
					{ type: "text", text: "Anthropic answer" },
				],
			}),
		);

		const result = await searchNativeWeb({
			models: runtime({ apiKey: "secret", headers: { "anthropic-beta": "custom-beta" } }),
			model: model("anthropic", "claude-sonnet", "https://api.anthropic.com"),
			query: "bear release",
			limit: 3,
			fetch,
		});

		expect(result).toMatchObject({
			providerId: "anthropic",
			answer: "Anthropic answer",
			searchQueries: ["bear release"],
			sources: [{ title: "Anthropic source", url: "https://example.com/anthropic" }],
		});
		const [, init] = fetch.mock.calls[0] ?? [];
		expect(new Headers(init?.headers).get("x-api-key")).toBe("secret");
		expect(new Headers(init?.headers).get("anthropic-beta")).toBe(
			"custom-beta,web-search-2025-03-05",
		);
		expect(JSON.parse(String(init?.body))).toMatchObject({
			tools: [{ type: "web_search_20250305", name: "web_search" }],
		});
	});

	it("uses DeepSeek's Anthropic-compatible native search endpoint", async () => {
		const fetch = vi.fn(async () =>
			jsonResponse({
				id: "message-1",
				model: "deepseek-v4-flash",
				content: [
					{ type: "text", text: "I will search the web." },
					{
						type: "server_tool_use",
						name: "web_search",
						input: { query: "bear release" },
					},
					{
						type: "web_search_tool_result",
						content: [
							{
								type: "web_search_result",
								title: "DeepSeek source",
								url: "https://example.com/deepseek",
							},
						],
					},
					{
						type: "text",
						text: "DeepSeek answer",
						citations: [
							{
								type: "web_search_result_location",
								title: "DeepSeek source",
								url: "https://example.com/deepseek",
								cited_text: "DeepSeek evidence",
							},
						],
					},
				],
			}),
		);

		const result = await searchNativeWeb({
			models: runtime(),
			model: model("deepseek", "deepseek-v4-flash", "https://api.deepseek.com"),
			query: "bear release",
			limit: 4,
			fetch,
		});

		expect(result).toEqual({
			providerId: "deepseek",
			modelId: "deepseek-v4-flash",
			answer: "DeepSeek answer",
			sources: [
				{
					title: "DeepSeek source",
					url: "https://example.com/deepseek",
					snippet: "DeepSeek evidence",
				},
			],
			searchQueries: ["bear release"],
		});
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe("https://api.deepseek.com/anthropic/v1/messages");
		const headers = new Headers(init?.headers);
		expect(headers.get("x-api-key")).toBe("secret");
		expect(headers.get("authorization")).toBe("Bearer secret");
		expect(headers.get("anthropic-version")).toBe("2023-06-01");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			model: "deepseek-v4-flash",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Perform a web search for the query: bear release" }],
				},
			],
			tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
		});
	});

	it("uses Gemini Google Search grounding and maps grounding metadata", async () => {
		const fetch = vi.fn(async () =>
			jsonResponse({
				modelVersion: "gemini-search",
				candidates: [
					{
						content: { parts: [{ text: "Gemini answer" }] },
						groundingMetadata: {
							webSearchQueries: ["bear latest release"],
							groundingChunks: [
								{ web: { title: "Gemini source", uri: "https://example.com/gemini" } },
							],
							groundingSupports: [
								{ segment: { text: "Grounded claim" }, groundingChunkIndices: [0] },
							],
						},
					},
				],
			}),
		);

		const result = await searchNativeWeb({
			models: runtime(),
			model: model("google", "gemini-search", "https://generativelanguage.googleapis.com/v1beta"),
			query: "bear latest release",
			limit: 4,
			fetch,
		});

		expect(result).toMatchObject({
			providerId: "google",
			answer: "Gemini answer",
			searchQueries: ["bear latest release"],
			sources: [
				{
					title: "Gemini source",
					url: "https://example.com/gemini",
					snippet: "Grounded claim",
				},
			],
		});
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-search:generateContent",
		);
		expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("secret");
		expect(JSON.parse(String(init?.body))).toMatchObject({ tools: [{ googleSearch: {} }] });
	});

	it("uses xAI Responses search without forcing OpenAI-only tool choice", async () => {
		const fetch = vi.fn(async () =>
			jsonResponse({
				model: "grok-search",
				output: [
					{ type: "web_search_call", results: [{ url: "https://example.com/xai" }] },
					{ type: "message", content: [{ type: "output_text", text: "Grok answer" }] },
				],
			}),
		);

		await searchNativeWeb({
			models: runtime(),
			model: model("xai", "grok-search", "https://api.x.ai/v1"),
			query: "live event",
			limit: 3,
			fetch,
		});

		const [, init] = fetch.mock.calls[0] ?? [];
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		expect(body.tools).toEqual([{ type: "web_search" }]);
		expect(body).not.toHaveProperty("tool_choice");
		expect(body).not.toHaveProperty("include");
	});

	it("does not call a provider when native search is unsupported", async () => {
		const models = runtime();
		await expect(
			searchNativeWeb({
				models,
				model: model("openrouter"),
				query: "news",
				limit: 3,
			}),
		).rejects.toMatchObject({ code: "native_web_search_provider_unsupported" });
		expect(models.getAuth).not.toHaveBeenCalled();
	});

	it("never sends provider OAuth credentials to a custom endpoint", async () => {
		const fetch = vi.fn();
		await expect(
			searchNativeWeb({
				models: runtime({ apiKey: "sk-ant-oat-secret" }, true),
				model: model("anthropic", "claude-sonnet", "https://proxy.example/v1"),
				query: "news",
				limit: 3,
				fetch,
			}),
		).rejects.toMatchObject({ code: "native_web_search_oauth_endpoint_untrusted" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("accepts header-owned Anthropic authentication", async () => {
		const fetch = vi.fn(async () =>
			jsonResponse({
				model: "claude-sonnet",
				content: [
					{ type: "server_tool_use", name: "web_search", input: { query: "news" } },
					{ type: "web_search_tool_result", tool_use_id: "search-1", content: [] },
					{ type: "text", text: "Answer" },
				],
			}),
		);
		await searchNativeWeb({
			models: runtime({ headers: { Authorization: "Bearer configured" } }),
			model: model("anthropic", "claude-sonnet", "https://api.anthropic.com"),
			query: "news",
			limit: 3,
			fetch,
		});
		const [, init] = fetch.mock.calls[0] ?? [];
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer configured");
		expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
	});

	it("bounds provider failures without echoing an upstream response body", async () => {
		const fetch = vi.fn(async () => jsonResponse({ secret: "must-not-leak" }, 401));
		let error: unknown;
		try {
			await searchNativeWeb({
				models: runtime(),
				model: model("openai"),
				query: "news",
				limit: 3,
				fetch,
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(NativeWebSearchError);
		expect(error).toMatchObject({ code: "native_web_search_http_error", status: 401 });
		expect(String(error)).not.toContain("must-not-leak");
	});
});

describe("documented search completion and error contracts", () => {
	// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool#errors
	it.each(["anthropic", "deepseek"])("rejects %s HTTP-200 tool errors", async (provider) => {
		await expect(
			searchNativeWeb({
				models: runtime(),
				model: model(provider),
				query: "news",
				limit: 3,
				fetch: vi.fn(async () =>
					jsonResponse({
						id: "msg_error",
						type: "message",
						role: "assistant",
						stop_reason: "end_turn",
						content: [
							{
								type: "web_search_tool_result",
								tool_use_id: "srv_1",
								content: { type: "web_search_tool_result_error", error_code: "unavailable" },
							},
							{ type: "text", text: "Unable to search" },
						],
						usage: { input_tokens: 10, output_tokens: 4 },
					}),
				),
			}),
		).rejects.toMatchObject({ code: "native_web_search_provider_failed" });
	});

	it("replays paused Messages content unchanged and keeps prior evidence", async () => {
		const content = [
			{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "news" } },
			{
				type: "web_search_tool_result",
				tool_use_id: "srv_1",
				content: [
					{
						type: "web_search_result",
						url: "https://example.com/",
						title: "Source",
						encrypted_content: "opaque-provider-data",
					},
				],
			},
		];
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({ type: "message", role: "assistant", content, stop_reason: "pause_turn" }),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "Final answer" }],
					stop_reason: "end_turn",
				}),
			);
		const result = await searchNativeWeb({
			models: runtime(),
			model: model("anthropic"),
			query: "news",
			limit: 3,
			fetch,
		});
		expect(result.answer).toBe("Final answer");
		expect(result.sources).toEqual([{ title: "Source", url: "https://example.com/" }]);
		expect(JSON.parse(fetch.mock.calls[1]?.[1].body).messages[1]).toEqual({
			role: "assistant",
			content,
		});
	});

	it.each(["failed", "incomplete"])(
		"rejects Responses status %s despite readable output",
		async (status) => {
			await expect(
				searchNativeWeb({
					models: runtime(),
					model: model("openai"),
					query: "news",
					limit: 3,
					fetch: vi.fn(async () =>
						jsonResponse({
							status,
							output: [
								{ type: "web_search_call", status: "completed" },
								{ type: "message", content: [{ type: "output_text", text: "Partial" }] },
							],
						}),
					),
				}),
			).rejects.toMatchObject({ code: "native_web_search_provider_failed" });
		},
	);

	// https://developers.openai.com/api/reference/resources/responses/streaming-events
	it("does not duplicate Codex output when the terminal event repeats completed items", async () => {
		const output = [
			{
				id: "ws_1",
				type: "web_search_call",
				status: "completed",
				action: { type: "search", query: "news" },
			},
			{
				id: "msg_1",
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Once", annotations: [] }],
			},
		];
		const events = [
			...output.map((item, output_index) => ({
				type: "response.output_item.done",
				output_index,
				item,
			})),
			{
				type: "response.completed",
				response: { id: "resp_1", object: "response", status: "completed", output },
			},
		];
		const fetch = vi.fn(
			async () =>
				new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
		);
		const result = await searchNativeWeb({
			models: runtime(),
			model: model("openai-codex"),
			query: "news",
			limit: 3,
			fetch,
		});
		expect(result.answer).toBe("Once");
	});

	it("rejects Codex streams that close before the terminal event", async () => {
		await expect(
			searchNativeWeb({
				models: runtime(),
				model: model("openai-codex"),
				query: "news",
				limit: 3,
				fetch: vi.fn(
					async () => new Response('data: {"type":"response.web_search_call.completed"}\n\n'),
				),
			}),
		).rejects.toMatchObject({ code: "native_web_search_stream_incomplete" });
	});

	// https://docs.x.ai/developers/tools/citations: annotations live on output_text.
	it("accepts xAI citation-bearing output without invented search_results blocks", async () => {
		const result = await searchNativeWeb({
			models: runtime(),
			model: model("xai"),
			query: "news",
			limit: 3,
			fetch: vi.fn(async () =>
				jsonResponse({
					id: "resp_1",
					object: "response",
					status: "completed",
					output: [
						{
							id: "msg_1",
							type: "message",
							role: "assistant",
							status: "completed",
							content: [
								{
									type: "output_text",
									text: "Answer [1]",
									annotations: [
										{
											type: "url_citation",
											title: "1",
											url: "https://example.com/",
											start_index: 7,
											end_index: 10,
										},
									],
								},
							],
						},
					],
				}),
			),
		});
		expect(result.sources).toEqual([{ title: "1", url: "https://example.com/" }]);
	});

	it("does not treat empty Google grounding metadata as executed search", async () => {
		await expect(
			searchNativeWeb({
				models: runtime(),
				model: model("google"),
				query: "news",
				limit: 3,
				fetch: vi.fn(async () =>
					jsonResponse({
						candidates: [
							{
								content: { role: "model", parts: [{ text: "Unsearched answer" }] },
								finishReason: "STOP",
								groundingMetadata: {},
							},
						],
					}),
				),
			}),
		).rejects.toMatchObject({ code: "native_web_search_not_invoked" });
	});
});

describe("web_search Pi tool", () => {
	it("keeps the provider result in an ordinary Pi tool result", async () => {
		const data = {
			providerId: "openai",
			modelId: "gpt-search",
			answer: "Answer",
			sources: [{ title: "Source", url: "https://example.com/" }],
		};
		const webSearch = vi.fn(async () => ({ message: "Readable answer", data }));
		const tools = registerHostTools({ webSearch } as never);
		const signal = new AbortController().signal;
		const result = await tools.web_search?.execute(
			"search-1",
			{ query: "current info", limit: 5 },
			signal,
		);

		expect(webSearch).toHaveBeenCalledWith("current info", 5, signal);
		expect(result?.details).toMatchObject({ ok: true, data: { answer: "Answer" } });
		expect(result?.content[0]).toEqual({ type: "text", text: "Readable answer" });
	});

	it("formats normalized search evidence for the model", () => {
		expect(
			formatNativeWebSearchResult({
				providerId: "google",
				modelId: "gemini-search",
				answer: "Answer",
				sources: [{ title: "Docs", url: "https://example.com/", snippet: "Evidence" }],
			}),
		).toBe("Answer\n\nSources (1):\n1. Docs\n   https://example.com/\n   Evidence");
	});
});
