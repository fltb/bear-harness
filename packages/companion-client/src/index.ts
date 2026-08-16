/**
 * Neutral companion client for the Bear Harness host link.
 *
 * `createCompanionClient(transport)` builds a facade that exactly mirrors the
 * desktop preload's `window.bearDesktop.companion` surface over any
 * `HostTransport` implementation (Electron `ipcRenderer`, WebSocket, ...).
 * This package has no Electron, DOM, Solid, or Node imports.
 */

export type { IpcError } from "@bear-harness/protocol";
export { type CompanionClient, createCompanionClient, type HostTransport } from "./client.js";
export { unwrap } from "./unwrap.js";
