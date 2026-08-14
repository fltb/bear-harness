/**
 * Pi RPC worker adapter (M3 executor layer).
 * Thin adapter over the Companion runtime command surface for Pi RPC
 * commissions. The runtime is Host-local; this adapter receives plain Host
 * command objects and normalizes its domain evidence into evidence rows.
 *
 * The adapter does not own run lifecycle state — the CommissionService
 * tracks runs and the run FSM (max 2 active) gates transitions. The adapter:
 *
 *   1. records a run manifest at launch, carrying a startCursor into the
 *      event bus so evidence published since launch can be replayed after a
 *      crash,
 *   2. dispatches RPC commands via the supervisor's sendCommand,
 *   3. normalizes inbound worker events into evidence rows,
 *   4. exposes run-scoped observation of the normalized evidence stream, and
 *   5. marks runs disposed, dropping any evidence that arrives afterwards.
 *
 * Secrets never enter the manifest: only envKeys are recorded, matching the
 * credential-store contract ("secrets never enter the renderer, run
 * manifest, evidence, or diagnostics").
 */

import { randomUUID } from "node:crypto";
import { type DatabaseSync } from "node:sqlite";
import type { EventBus, EventListener } from "../storage/event-bus.js";
import type { CompanionSupervisor } from "../companion/supervisor.js";

export interface PiLaunchParams {
	commissionId: string;
	runId: string;
	cwd: string;
	authorizedRoots?: string[];
	toolSet?: string[];
	env?: Record<string, string>;
}

/** The manifest recorded in `run_manifests.manifest_json` at launch. */
export interface PiRunManifest {
	commissionId: string;
	runId: string;
	cwd: string;
	authorizedRoots: string[];
	toolSet: string[];
	envKeys: string[];
	/** Event bus seq at launch; replay `evidence.collected` from here to recover. */
	startCursor: number;
}

/** Payload of the `evidence.collected` domain event (seq rides on the HostEvent). */
export interface EvidenceCollected {
	runId: string;
	evidenceId: string;
	kind: string;
}

export class PiRpcAdapter {
	private db: DatabaseSync;
	private eventBus: EventBus;
	private supervisor: CompanionSupervisor;
	private disposedRuns = new Set<string>();

	constructor(db: DatabaseSync, eventBus: EventBus, supervisor: CompanionSupervisor) {
		this.db = db;
		this.eventBus = eventBus;
		this.supervisor = supervisor;
	}

	/**
	 * Record a run manifest and dispatch the start RPC command.
	 *
	 * The `runs` row is expected to already exist (created by the
	 * CommissionService/run FSM before a run is launched); the adapter only
	 * writes the manifest and hands the run to the worker.
	 */
	async launch(params: PiLaunchParams): Promise<PiRunManifest> {
		const { commissionId, runId, cwd } = params;
		const manifest: PiRunManifest = {
			commissionId,
			runId,
			cwd,
			authorizedRoots: params.authorizedRoots ?? [],
			toolSet: params.toolSet ?? [],
			envKeys: Object.keys(params.env ?? {}),
			startCursor: this.eventBus.currentSeq,
		};

		this.db
			.prepare("INSERT INTO run_manifests (id, run_id, manifest_json) VALUES (?, ?, ?)")
			.run(randomUUID(), runId, JSON.stringify(manifest));

		// Dispatch the run over the supervisor's postMessage bridge; the
		// bridge applies the LF JSONL framing (verified in M0), so sendCommand
		// receives the plain JSON object.
		this.supervisor.sendCommand({
			type: "run.start",
			commissionId,
			runId,
			cwd,
			authorizedRoots: manifest.authorizedRoots,
			toolSet: manifest.toolSet,
			env: params.env ?? {},
		});

		return manifest;
	}

	/**
	 * Normalize an already-framed worker event into an evidence row.
	 *
	 * Called by the postMessage bridge owner (CommissionService) for each
	 * inbound worker message. Events for disposed runs are dropped.
	 */
	collectEvidence(runId: string, event: { type: string; [key: string]: unknown }): void {
		if (this.disposedRuns.has(runId)) return;

		const evidenceId = randomUUID();
		this.db
			.prepare("INSERT INTO evidence (id, run_id, kind, data) VALUES (?, ?, ?, ?)")
			.run(evidenceId, runId, event.type, JSON.stringify(event));

		this.eventBus.publish("evidence.collected", {
			runId,
			evidenceId,
			kind: event.type,
		} satisfies EvidenceCollected);
	}

	/**
	 * Subscribe to evidence events for a run. Returns an unsubscribe function.
	 *
	 * Pass `afterSeq` (e.g. the manifest's startCursor) to replay evidence
	 * collected since that event bus seq — the recovery path after a crash.
	 */
	observe(runId: string, listener: EventListener, afterSeq?: number): () => void {
		return this.eventBus.subscribe((event) => {
			if (event.kind !== "evidence.collected") return;
			const payload = event.payload as EvidenceCollected | null;
			if (payload?.runId !== runId) return;
			listener(event);
		}, afterSeq);
	}

	/** Mark a run disposed; evidence arriving afterwards is dropped. */
	dispose(runId: string): void {
		this.disposedRuns.add(runId);
		this.eventBus.publish("run.disposed", { runId });
	}
}
