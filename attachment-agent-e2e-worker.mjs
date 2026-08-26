#!/usr/bin/env node
// Seatbelt grants the entrypoint directory read-only. Keeping this source-E2E
// bootstrap at the repository root makes the real worker's bare dependencies
// readable without adding any writable path or weakening native confinement.

import "./packages/host-runtime/dist/executors/pi-acp-worker.js";
