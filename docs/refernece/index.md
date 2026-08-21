# Reference index

This directory is the maintainer map for the current Bear Harness implementation. The directory spelling `docs/refernece/` is intentional and must be preserved.

Start with [architecture](./architecture.md) for the cross-package dependency, transport, state, security, and release model. Then use the module references below for source-level ownership and extension details. The product interaction decisions behind message-scoped work and ResultSpace are recorded in the [role-first work interaction plan](../role-first-work-interaction-plan.md). Cross-module observations are collected in [issues and findings](./issues-and-findings.md).

## Module ownership

| Module reference | Owns | Start here when… |
| --- | --- | --- |
| [Product configuration](./product-config.md) | Release identity, brand metadata, data-directory naming, default character selection, icon/license metadata, and the optional update-feed setting. | Renaming or forking the product, changing packaged identity/assets, selecting the default character, or enabling update staging. |
| [Protocol and schema](./protocol-schema.md) | Zod wire schemas, the `RPC` endpoint registry, request/response inference, envelopes, event/snapshot shapes, and shared schema utilities. | Adding or versioning an RPC, changing a payload, tightening a boundary, or checking what a transport is allowed to send. |
| [Companion client](./companion-client.md) | The transport-neutral typed renderer facade, request/response parsing, envelope handling, and `HostTransport` contract. | Adding a renderer transport or client method, changing envelope behavior, or preserving parity between Electron and WebDev. |
| [Host runtime](./host-runtime.md) | Canonical SQLite state, RPC dispatch/handlers, conversations and turns, character/roleplay authority, providers/models, commissions/runs, artifacts, memory integration, events, audit, and host security policy. | Changing application behavior, persistence, execution approval, model routing, roleplay effects, or any authoritative state transition. |
| [Tdai core](./tdai-core.md) | Host-neutral L0/L1/L2/L3 memory capture, extraction, scene/persona material, stores, embeddings, scheduling, checkpoints, and recall. | Changing memory capture/recall, embedding backends, memory pipeline timing, or host integration without adding host assumptions to memory algorithms. |
| [Companion UI](./companion-ui.md) | Solid renderer composition, reactive projections, conversation/composer, onboarding presentation, settings/backstage, work timeline, ResultSpace, roleplay presentation, accessibility, and product i18n consumption. | Changing user-visible renderer behavior, message operations, work/result presentation, image routing, or UI state projection. |
| [Desktop](./desktop.md) | Electron main process, preload bridge, renderer admission, IPC routing, artifact custom scheme, credential vault, diagnostics, update service, packaging, and release targets. | Changing native capabilities, IPC admission, packaged artifact serving, credential storage, crash diagnostics, or Electron packaging. |
| [WebDev](./web-dev.md) | The loopback Node Host, Rsbuild browser app/proxy, bootstrap token, debug/diagnostics routes, process-scoped data directories, and deterministic Playwright provider harness. | Changing local browser development, WebDev transport/bootstrap, debug routes, E2E isolation, or deterministic provider behavior. |
| [i18n](./i18n.md) | Product/interface catalogs, locale selection/persistence, typed translation keys, English parity, and generated Traditional Chinese output. | Changing product buttons, headings, errors, statuses, accessibility copy, or supported product locales. Character-package language remains package-owned. |

## Task-based navigation

| Task | Primary owner | Supporting boundary |
| --- | --- | --- |
| Add an RPC | [Protocol and schema](./protocol-schema.md) | Register the Host handler in [Host runtime](./host-runtime.md), call it through [Companion client](./companion-client.md), then project it in [Companion UI](./companion-ui.md). Electron and WebDev enumerate the shared registry automatically. |
| Change canonical application state | [Host runtime](./host-runtime.md) | Update the protocol shape when it crosses RPC, then update event/snapshot projections in [Companion UI](./companion-ui.md). |
| Change a conversation turn or model route | [Host runtime](./host-runtime.md) | Renderer behavior belongs to [Companion UI](./companion-ui.md); wire shape belongs to [Protocol and schema](./protocol-schema.md). |
| Change memory capture, extraction, embeddings, or recall | [Tdai core](./tdai-core.md) | Host scoping, turn hooks, and user-facing memory operations belong to [Host runtime](./host-runtime.md). |
| Change character declarations, onboarding prose, roleplay media, or role-specific work labels | Character package data and the [Host runtime](./host-runtime.md) package boundary | Product chrome and neutral fallback copy belong to [i18n](./i18n.md); rendering belongs to [Companion UI](./companion-ui.md). |
| Change work approval, permissions, run controls, or artifact production | [Host runtime](./host-runtime.md) | Message placement and ResultSpace are [Companion UI](./companion-ui.md); the product interaction contract is in the [work plan](../role-first-work-interaction-plan.md). |
| Change artifact preview or native artifact URLs | [Companion UI](./companion-ui.md) for presentation; [Desktop](./desktop.md) for `bear-artifact://` serving | Artifact metadata, lookup, and authorization remain Host-owned. |
| Change Electron-only behavior | [Desktop](./desktop.md) | Keep shared behavior in [Host runtime](./host-runtime.md) and the renderer bridge in [Companion client](./companion-client.md). |
| Change browser development or Web E2E | [WebDev](./web-dev.md) | Preserve the same Host contract and typed client semantics documented in [Companion client](./companion-client.md). |
| Change product naming, branding, data isolation, or packaging identity | [Product configuration](./product-config.md) | Verify both [Desktop](./desktop.md) and [WebDev](./web-dev.md) consumers. |
| Change product-language copy or locale behavior | [i18n](./i18n.md) | Do not move character-package prose into product catalogs. |

## Recommended reading order

1. [Architecture](./architecture.md) for the system map and authority boundaries.
2. [Protocol and schema](./protocol-schema.md) for the wire contract.
3. [Host runtime](./host-runtime.md) for persistence and decisions.
4. [Companion client](./companion-client.md) and [Companion UI](./companion-ui.md) for renderer flow.
5. [Desktop](./desktop.md) or [WebDev](./web-dev.md) for the selected delivery shell.
6. [Tdai core](./tdai-core.md), [Product configuration](./product-config.md), and [i18n](./i18n.md) for cross-cutting services.

When a change spans rows, start with the owner that makes the authoritative decision, then follow the supporting boundary links. Do not create a second channel registry, state authority, product catalog, or character-package copy source beside the documented owner.
