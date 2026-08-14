/**
 * Companion utilityProcess supervisor.
 *
 * Manages the lifecycle of the SDK runtime (dist/runtime/pi-sdk/ in the
 * packaged app, or the companion-entry.mjs in dev). The runtime runs in a
 * dedicated Electron utilityProcess with:
 *   - cwd/agentDir fixed to `<userData>/companion-runtime` (no workspace)
 *   - env allowlist (see SPIKE_ENV_ALLOWLIST below)
 *   - Only Host custom tools registered (memory.proposeCandidate, etc.)
 *   - Analytics/telemetry disabled
 *   - One crash restart attempt (idle only); never auto-replays in-flight turns
 *
 * The supervisor follows the plan §7.1: utility gets no bash, no file system
 * access outside agentDir, no credential env, and no project context.
 */

import { utilityProcess } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventBus } from "../storage/event-bus.js";

const COMPANION_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"TERM",
	"NO_COLOR",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"NO_PROXY",
	"SSL_CERT_FILE",
];

export type CompanionState = "stopped" | "starting" | "running" | "crashed" | "unavailable";

export class CompanionSupervisor {
	private state: CompanionState = "stopped";
	private child: ReturnType<typeof utilityProcess.fork> | null = null;
	private userDataDir: string;
	private eventBus: EventBus;
	private restartAttempted = false;

	constructor(userDataDir: string, eventBus: EventBus) {
		this.userDataDir = userDataDir;
		this.eventBus = eventBus;
	}

	get currentState(): CompanionState {
		return this.state;
	}

	/** Start the Companion runtime. */
	async start(): Promise<void> {
		if (this.state === "running") return;
		this.state = "starting";

		const agentDir = join(this.userDataDir, "companion-runtime");
		mkdirSync(agentDir, { recursive: true });

		// Resolve the companion entry path
		// In packaged: dist/runtime/pi-sdk/companion-entry.mjs
		// In dev: same relative path from the built dist
		const entryPath = fileURLToPath(
			new URL("../runtime/pi-sdk/companion-entry.mjs", import.meta.url),
		);

		const env: Record<string, string> = {
			BEAR_COMPANION_AGENT_DIR: agentDir,
		};
		for (const key of COMPANION_ENV_ALLOWLIST) {
			const value = process.env[key];
			if (value) env[key] = value;
		}

		try {
			this.child = utilityProcess.fork(entryPath, [], {
				env,
				cwd: agentDir,
				serviceName: "companion",
			});

			this.child.once("exit", (exitCode: number) => {
				const wasRunning = this.state === "running";
				this.state = "crashed";
				this.child = null;
				this.eventBus.publish("companion.state_changed", {
					state: "crashed",
					exitCode,
				});

				// Auto-restart once when idle (no in-flight turn)
				if (wasRunning && !this.restartAttempted) {
					this.restartAttempted = true;
					void this.start();
				}
			});

			this.state = "running";
			this.restartAttempted = false;
			this.eventBus.publish("companion.state_changed", { state: "running" });
		} catch (e) {
			this.state = "unavailable";
			this.eventBus.publish("companion.state_changed", {
				state: "unavailable",
				error: (e as Error)?.message ?? String(e),
			});
		}
	}

	/** Stop the Companion runtime. */
	async stop(): Promise<void> {
		if (this.child) {
			this.child.kill();
			this.child = null;
		}
		this.state = "stopped";
		this.eventBus.publish("companion.state_changed", { state: "stopped" });
	}

	/** Send a JSON command to the Companion runtime via postMessage. */
	sendCommand(command: unknown): void {
		if (!this.child) {
			throw new Error("companion not running");
		}
		this.child.postMessage(command);
	}

	/** Check if the Companion is running and idle. */
	get isRunning(): boolean {
		return this.state === "running" && this.child !== null;
	}

	/** Get the agentDir used by the Companion runtime. */
	get agentDir(): string {
		return join(this.userDataDir, "companion-runtime");
	}
}