# Bear Harness

Multi-package host runtime + companion UI for the Cyber Bear conversational AI platform, featuring TdaiCore — a full-power local-first memory pipeline with offline embedding, scene extraction, and persona recall.

## Packages

| Package | Role |
|---|---|
| `tdai-core` | Memory pipeline engine: L0 capture, L1 LLM extraction, L2 scene clustering, L3 persona synthesis, BM25 hybrid recall |
| `host-runtime` | Host application adapter: TencentDbRuntime bridge, CyberBear LLM runner, memory settings, proxy hot-reload, local embedding |
| `companion-ui` | Desktop/web UI: settings sheet, NetworkAndMemorySettings, memory viewer, backstage |
| `companion-client` | IPC client for companion-ui → host-runtime |
| `protocol` | Shared RPC schema (Zod) |
| `i18n` | Localization (zh-CN, zh-TW, en) |
| `product-config` | Product branding/config for forked builds |

## Key Architectural Decisions

### Memory Pipeline (TdaiCore, full-power cutover)

The old regex-based memory stub (`MemoryAutomation.detectMemory()`) has been replaced by a full TdaiCore pipeline:

```
L0 capture → L1 LLM extraction → L2 scene clustering → L3 persona recall
            ↕
       BM25 FTS + vector hybrid search
```

- **L0**: Per-session incremental capture with cursor checkpointing (no duplicates)
- **L1**: LLM-based JSON extraction via configurable runner (host adapter or standalone)
- **L2/L3**: Scene clustering and persona synthesis (deferred batch)
- **Recall**: BM25 FTS (jieba/CJK) + optional vector search when embedding is configured

### Proxy Hot-Reload

`HostRuntime.start()` subscribes to `settings.changed` events (via `eventBus`) and re-applies `applyProxyConfig` when the proxy setting changes. Cleanup via `unsubscribeProxyHotReload` in `close()`.

### Local Embedding

Three local GGUF models are configured as presets. The `hf:` prefix is resolved by `node-llama-cpp`:

| Preset | HF Path | Status |
|---|---|---|
| `embeddinggemma` (default) | `hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf` | 200, 313 MB |
| `bge-base-zh` | `hf:CompendiumLabs/bge-small-zh-v1.5-gguf/bge-small-zh-v1.5-q8_0.gguf` | 200, verified |
| `multilingual-e5` | `hf:dinab/multilingual-e5-base-Q8_0-GGUF/multilingual-e5-base-q8_0.gguf` | 200, 289 MB (public mirror; official repo is gated) |

`node-llama-cpp` is an optional dependency in `host-runtime`; the embedding provider falls back to remote when the local model is unavailable.

### Settings Schema

Settings are persisted in the `app_settings` row via the host RPC:

- `networkProxy`: `{ mode: "direct" | "auto" | "manual", url?: string }`
- `memoryVectorService`: `{ enabled, provider, baseUrl, apiKey, model, dimensions, localModel, customPath }`
- `modelDownloadMirror`: `{ endpoint?: string }`

### LLM Extraction Runner

The pipeline uses `CyberBearLLMRunner` (via `CyberBearHostAdapter`) by default. When `cfg.llm.enabled` is set and the host type is OpenClaw, a `StandaloneLLMRunnerFactory` overrides the host runner.

## Verification

- `packages/host-runtime/tests/tencentdb-runtime.spec.ts`: 11 tests covering core config, memoryConfig injection, extraction pipeline, recall, and edit
- `packages/companion-ui/tests/network-memory-settings.spec.tsx`: 8 tests for proxy/vector/mirror settings UI
- All 112 companion-ui tests pass, 23 test files
- TypeScript typecheck: clean across all packages

## Development

```bash
# Install (with optional node-llama-cpp postinstall)
npm install --dangerously-allow-all-scripts
```

See `docs/` for roadmap and design documents.