// @vitest-environment node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDiagnostics, type DiagnosticsApp } from "../../src/diagnostics/index.js";
import { currentTraceContext } from "../../src/diagnostics/trace.js";
import { allJsonlText, readJsonlLines, smallPolicy } from "../utils";

const SENTINEL_CONVERSATION = "秘密对话内容-P0";
const SENTINEL_PROMPT = "PROMPT-SECRET-TOKEN";
const SENTINEL_PATH = "/Users/secret-user/Documents/top-secret.txt";
const SENTINEL_STACK = "at Function.xyz (internal/secret.js:12:3)";

function makeApp(): {
	app: DiagnosticsApp;
	setAppLogsPath: ReturnType<typeof vi.fn>;
	setPath: ReturnType<typeof vi.fn>;
} {
	const setAppLogsPath = vi.fn();
	const setPath = vi.fn();
	return {
		app: { setAppLogsPath, setPath },
		setAppLogsPath,
		setPath,
	};
}

function makeDiagnostics(options: {
	root: string;
	launchId: string;
	packaged?: boolean;
	heartbeatMs?: number;
}) {
	const { app, setAppLogsPath, setPath } = makeApp();
	const reporter = { start: vi.fn() };
	const diagnostics = createDiagnostics({
		app,
		root: options.root,
		launchId: options.launchId,
		packaged: options.packaged ?? false,
		heartbeatMs: options.heartbeatMs ?? 0,
		pruneIntervalMs: 0,
		policy: smallPolicy({ maxBytes: 10_000 }),
		reporter,
	});
	return { diagnostics, setAppLogsPath, setPath, reporter };
}

describe("Diagnostics orchestrator", () => {
	it("initializes dirs, crashpad and marker before returning; shutdown flushes everything", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-diag-"));
		const launchId = "launch-init";
		const { diagnostics, setAppLogsPath, setPath, reporter } = makeDiagnostics({ root, launchId });

		expect(existsSync(join(root, "logs"))).toBe(true);
		expect(existsSync(join(root, "crashes"))).toBe(true);
		expect(existsSync(join(root, "state"))).toBe(true);
		expect(setAppLogsPath).toHaveBeenCalledWith(join(root, "logs"));
		expect(setPath).toHaveBeenCalledWith("crashDumps", join(root, "crashes", launchId));
		expect(reporter.start).toHaveBeenCalledWith({
			uploadToServer: false,
			globalExtra: { diagnostics_schema: "1", launch_id: launchId },
		});
		const marker = JSON.parse(
			readFileSync(join(root, "state", `run-${launchId}.json`), "utf8"),
		) as {
			state: string;
			pid: number;
		};
		expect(marker.state).toBe("running");
		expect(marker.pid).toBe(process.pid);

		await diagnostics.shutdown();
		const records = readJsonlLines(root);
		expect(records.map((r) => r.name)).toEqual(["diagnostics.prune", "app.started", "app.session"]);
		const session = records[2];
		expect(session?.kind).toBe("span");
		expect(session?.status).toBe("ok");
		const markerAfter = JSON.parse(
			readFileSync(join(root, "state", `run-${launchId}.json`), "utf8"),
		) as {
			state: string;
		};
		expect(markerAfter.state).toBe("clean");
		rmSync(root, { recursive: true, force: true });
	});

	it("parents app.started under the app.session span and propagates context via runInSession", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-diag-"));
		const launchId = "launch-context";
		const { diagnostics } = makeDiagnostics({ root, launchId });

		const sessionTrace = diagnostics.runInSession(() => currentTraceContext());
		expect(sessionTrace).toBeDefined();
		diagnostics.runInSession(() => diagnostics.emit("window.load_failed", { webContentsId: 1 }));

		await diagnostics.shutdown();
		const records = readJsonlLines(root);
		const started = records.find((r) => r.name === "app.started");
		const session = records.find((r) => r.name === "app.session");
		const loadFailed = records.find((r) => r.name === "window.load_failed");
		expect(started?.traceId).toBe(session?.traceId);
		expect(started?.parentSpanId).toBe(session?.spanId);
		// The event emitted inside runInSession shares the session trace.
		expect(loadFailed?.traceId).toBe(session?.traceId);
		rmSync(root, { recursive: true, force: true });
	});

	it("emits input_rejected{record} for catalog-invalid attributes and never serializes sentinels", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-diag-"));
		const launchId = "launch-sentinel";
		const { diagnostics } = makeDiagnostics({ root, launchId });

		// Valid events with hostile-looking-but-valid values.
		diagnostics.emit("app.started", {
			pid: 1,
			platform: "darwin",
			packaged: false,
		});
		// Invalid: unknown key carrying a sentinel value.
		diagnostics.emit("app.started", {
			pid: 1,
			platform: "darwin",
			packaged: false,
			conversation: SENTINEL_CONVERSATION,
		} as never);
		// Invalid: oversized attribute.
		diagnostics.emit("app.started", {
			pid: 1,
			platform: "darwin",
			packaged: false,
			padding: "x".repeat(10_000),
		} as never);
		// Invalid: wrong attribute type (a full Error object as value).
		diagnostics.emit("app.started", {
			pid: 1,
			platform: "darwin",
			packaged: new Error(SENTINEL_PROMPT) as unknown as boolean,
		});

		await diagnostics.shutdown();
		const text = allJsonlText(root);
		expect(text).not.toContain(SENTINEL_CONVERSATION);
		expect(text).not.toContain(SENTINEL_PROMPT);
		expect(text).not.toContain(SENTINEL_PATH);
		expect(text).not.toContain(SENTINEL_STACK);

		const records = readJsonlLines(root);
		expect(records.filter((r) => r.name === "diagnostics.input_rejected")).toHaveLength(3);
		rmSync(root, { recursive: true, force: true });
	});

	it("records previous unclean exits and defers retention when only active units exceed the budget", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-diag-"));
		const launchId = "launch-unclean";
		// A stale running marker with a dead pid (previous launch).
		const stateDir = join(root, "state");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "run-old-launch.json"),
			JSON.stringify({
				schemaVersion: 1,
				launchId: "old-launch",
				pid: 999_999_999,
				startedAt: "2026-01-01T00:00:00.000Z",
				lastSeenAt: "2026-01-01T00:00:00.000Z",
				state: "running",
			}),
		);
		// An active (current-launch) unit that exceeds the 10 KB budget: a huge
		// per-launch crash dir, which retention must protect and defer on.
		const crashDir = join(root, "crashes", launchId);
		mkdirSync(crashDir, { recursive: true });
		writeFileSync(join(crashDir, "huge.dmp"), "x".repeat(40_000));

		const { diagnostics } = makeDiagnostics({ root, launchId, packaged: true });
		await diagnostics.shutdown();

		const records = readJsonlLines(root);
		expect(
			records.some(
				(r) =>
					r.name === "app.previous_exit_unclean" &&
					(r.attributes as Record<string, unknown>).count === 1,
			),
		).toBe(true);
		expect(records.some((r) => r.name === "diagnostics.retention_deferred")).toBe(true);
		// The active unit survives.
		expect(existsSync(join(crashDir, "huge.dmp"))).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});

	it("emitRemote carries the remote trace and parent span", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-diag-"));
		const launchId = "launch-remote";
		const { diagnostics } = makeDiagnostics({ root, launchId });

		diagnostics.emitRemote(
			"renderer.fault",
			{ kind: "error", errorType: "TypeError" },
			{
				traceId: "ee".repeat(16),
				parentSpanId: "ff".repeat(8),
			},
		);

		await diagnostics.shutdown();
		const records = readJsonlLines(root);
		const fault = records.find((r) => r.name === "renderer.fault");
		expect(fault?.traceId).toBe("ee".repeat(16));
		expect(fault?.parentSpanId).toBe("ff".repeat(8));
		expect(fault?.spanId).toMatch(/^[0-9a-f]{16}$/);
		rmSync(root, { recursive: true, force: true });
	});

	it("span end is a no-op when called twice", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-diag-"));
		const launchId = "launch-span";
		const { diagnostics } = makeDiagnostics({ root, launchId });

		const span = diagnostics.startSpan("window.session", {});
		span.end("ok", { webContentsId: 1 });
		span.end("error", { webContentsId: 1 });

		await diagnostics.shutdown();
		const records = readJsonlLines(root);
		expect(records.filter((r) => r.name === "window.session")).toHaveLength(1);
		expect(records.find((r) => r.name === "window.session")?.status).toBe("ok");
		rmSync(root, { recursive: true, force: true });
	});

	it("shutdown is idempotent and disables the ALS store", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-diag-"));
		const launchId = "launch-shutdown";
		const { diagnostics } = makeDiagnostics({ root, launchId });

		await diagnostics.shutdown();
		await diagnostics.shutdown();
		const marker = JSON.parse(
			readFileSync(join(root, "state", `run-${launchId}.json`), "utf8"),
		) as { state: string };
		expect(marker.state).toBe("clean");
		expect(currentTraceContext()).toBeUndefined();
		rmSync(root, { recursive: true, force: true });
	});
});
