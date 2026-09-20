# Native web search protocol review

Reviewed 2026-09-20. Bear registers one ordinary Pi `web_search` tool. Each invocation
uses the owning Session's currently selected model and Pi-resolved credentials.
Auxiliary provider messages never enter the main transcript or a Bear transcript store.
The `limit` parameter bounds returned sources; it is not a provider result-count promise.

Tool exposure is conservative: a known provider, native API transport, official origin,
and supported model family must all match. Unknown families, custom gateways, and
specialized image/audio/embedding models hide `web_search`. Auth and network errors
do not change the capability decision. Pi's native active-tool list is filtered before
the Session is returned and on `model_select` (including restore/cycle), preserving all
other active tools. The definition stays in Pi's registry to enable supported switches.

| Route | Official request and response authority | Bear mapping |
| --- | --- | --- |
| OpenAI | [Web search](https://developers.openai.com/api/docs/guides/tools-web-search) | POST `/v1/responses`; Bearer auth; `tools: [{type: "web_search"}]`; `include: ["web_search_call.action.sources"]`. Parse `output` search actions and message `output_text.annotations` URL citations. |
| OpenAI Codex | [Streaming event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events) covers public events only | ChatGPT `/backend-api/codex/responses`, account header and `response.done` follow installed Pi 0.85.1 `api/openai-codex-responses.js`. There is no public contract for this login endpoint. Require a terminal event; final output replaces repeated item events. |
| Anthropic | [Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool), [Messages](https://platform.claude.com/docs/en/api/messages/create) | POST `/v1/messages`; `x-api-key`, `anthropic-version`; basic `web_search_20250305`. Parse result arrays and text citations. Tool errors can arrive with HTTP 200. Replay `pause_turn` content unchanged, including encrypted blocks, within the isolated call; at most three requests. OAuth headers follow Pi rather than the public API-key contract. |
| DeepSeek | [Anthropic compatibility](https://api-docs.deepseek.com/guides/anthropic_api/), [official harness provider](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-search-deepseek/src/provider.ts) | POST `/anthropic/v1/messages`; reuse configured key; native `web_search_20250305` as specified by the official harness. Require a result block. [Responses compatibility](https://api-docs.deepseek.com/guides/responses_api/) currently lists built-in tools as ignored. |
| Google | [generateContent reference](https://ai.google.dev/api/generate-content#GroundingMetadata) | POST `/v1beta/models/{model}:generateContent`; `x-goog-api-key`; `tools: [{googleSearch: {}}]`. Parse candidate text, `webSearchQueries`, `groundingChunks[].web`, and support indices. These are generateContent fields, not the separate Interactions API schema. |
| xAI | [Web Search](https://docs.x.ai/developers/tools/web-search), [Citations](https://docs.x.ai/developers/tools/citations) | POST `/v1/responses`; Bearer auth and `web_search`. Read `output[].content[].annotations` citations, including responses without a separate search-call item. Do not send OpenAI-specific source inclusion parameters. |

## Completion and errors

- Responses failures/incomplete statuses and failed search items are rejected even if text exists.
- Codex EOF without a terminal event is an incomplete stream. Item completion followed by
  terminal output does not duplicate the answer. Public `response.incomplete` is an error here.
- Messages tool-result error objects are rejected, rather than mistaken for successful search.
  Search narration preceding the final result is excluded from the answer. Citations enrich
  previously encountered result URLs. `max_tokens` and refusal are not accepted as completion.
- Empty Google grounding metadata does not establish search. Non-STOP candidate completion
  is rejected, thought parts are excluded, and grounding indices retain original positions.
- Requests share a 60-second deadline, honor Pi cancellation, refuse redirects, bound response
  bytes to 2 MiB, sanitize source URLs, and never return HTTP error bodies as tool evidence.

## Evidence and limits

`packages/host-runtime/tests/native-web-search.spec.ts` contains synthetic, documented-shape
examples, not captured responses. Tests check request fields, citation normalization,
HTTP-200 errors, paused continuation, incomplete Responses, repeated streaming output,
unexpected EOF, xAI citations, and empty Google grounding. The Pi runtime regression switches
the Session model between two searches and checks provider routing.

Documentation establishes wire formats, not access for every model, account, proxy, or OAuth
subscription. The Codex login endpoint remains an explicitly undocumented dependency.
Google search-entry-point rendering requirements still need product-level review before
release; normalized source data alone is not a claim of full grounding UI compliance.
Live background smoke subsequently passed with the existing Codex OAuth session
(`gpt-5.6-sol`) and the supplied DeepSeek test credential (`deepseek-v4-flash`). Both
returned search evidence through the actual adapter. Answer quality is not a transport
acceptance gate. No credentials are stored in these documents. No release acceptance
is claimed by this protocol review.

## Engineering scope

The branch touches three implementation modules, two test files, and this document
(six files). Model-capability and bidirectional switching regressions cover exposure.
Pi retains transcript and execution ownership; Bear owns only the auxiliary HTTP
request and normalized tool evidence. No database or renderer authority is added.

Release decision: do not publish from this review alone. Account-level live smoke,
grounding presentation review, and the repository's remaining release gates are
separate from the completed wire-format review and automated regression checks.
