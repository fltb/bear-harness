// @vitest-environment node

import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AcpProcessSpec } from "../src/executors/acp-client.js";
import { CodexAdapter } from "../src/executors/codex-adapter.js";
import { PiAcpAdapter, piModelEnvironment } from "../src/executors/pi-adapter.js";
import type { ExecutorLaunchRequest } from "../src/executors/router.js";
import { EventBus } from "../src/storage/event-bus.js";

const fixturePath = fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url));
const macOSConfinementAvailable =
	process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function fixtureDirectory(): string {
	const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "bear-executor-adapter-")));
	temporaryDirectories.push(directory);
	return directory;
}

function fixtureSpec(cwd: string): AcpProcessSpec {
	return { command: process.execPath, args: [fixturePath], cwd, env: { PATH: process.env.PATH } };
}

function createDatabase(): { db: DatabaseSync; eventBus: EventBus } {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
		CREATE TABLE run_manifests (
			id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			manifest_json TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
	return { db, eventBus: new EventBus(drizzle({ client: db })) };
}

function request(cwd: string, profile: ExecutorLaunchRequest["profile"]): ExecutorLaunchRequest {
	const outputDirectory = join(dirname(cwd), "run-1", "outputs");
	mkdirSync(outputDirectory, { recursive: true });
	return {
		run: { runId: "run-1", triggerEntryId: "entry-1", executorProfile: profile.id },
		task: { instruction: "Inspect the workspace.", workspace: cwd, outputDirectory },
		profile,
		emit: () => undefined,
	};
}

describe("ACP executor adapters", () => {
	it.skipIf(!macOSConfinementAvailable)(
		"launches confined Pi ACP with declared snapshots and records no secret manifest data",
		async () => {
			const root = fixtureDirectory();
			const cwd = join(root, "workspace");
			mkdirSync(cwd);
			const snapshotOne = join(root, "snapshot-one");
			const snapshotTwo = join(root, "snapshot-two");
			mkdirSync(snapshotOne);
			mkdirSync(snapshotTwo);
			writeFileSync(join(snapshotOne, "input.txt"), "snapshot-one");
			writeFileSync(join(snapshotTwo, "input.txt"), "snapshot-two");
			const { db } = createDatabase();
			const adapter = new PiAcpAdapter(
				drizzle({ client: db }),
				join(root, "user-data"),
				fixturePath,
			);
			const completed = Promise.withResolvers<void>();
			const run = request(cwd, {
				id: "pi-default",
				type: "pi",
				capabilities: {},
			});
			run.task.readOnlyPaths = [snapshotOne, snapshotTwo];
			run.task.modelRoute = {
				providerId: "provider-a",
				modelId: "model-a",
				apiKey: "process-only-secret",
			};
			run.emit = (event) => {
				if (event.type === "completed") completed.resolve();
			};

			await adapter.launch(run);
			await completed.promise;

			const manifest = JSON.parse(
				(
					db.prepare("SELECT manifest_json FROM run_manifests WHERE run_id = ?").get("run-1") as {
						manifest_json: string;
					}
				).manifest_json,
			) as Record<string, unknown>;
			expect(manifest).toMatchObject({ executor: "pi-acp", workerPath: fixturePath });
			expect(JSON.stringify(manifest)).not.toContain("apiKey");
			db.close();
		},
	);

	it("passes the selected Pi route and credential only through the worker environment", () => {
		expect(piModelEnvironment("provider-a", "model-a", "secret-a")).toEqual({
			BEAR_PI_PROVIDER_ID: "provider-a",
			BEAR_PI_MODEL_ID: "model-a",
			BEAR_PI_API_KEY: "secret-a",
		});
	});

	it.skipIf(!macOSConfinementAvailable)(
		"keeps the consented Codex ACP adapter functional under confinement",
		async () => {
			const root = fixtureDirectory();
			const cwd = join(root, "workspace");
			mkdirSync(cwd);
			const binary = join(cwd, "codex");
			writeFileSync(binary, "#!/bin/sh\necho 'codex 0.147.0'\n");
			chmodSync(binary, 0o755);
			const hash = createHash("sha256").update(readFileSync(binary)).digest("hex");
			const { db, eventBus } = createDatabase();
			class FixtureCodexAdapter extends CodexAdapter {
				protected override processSpec(): AcpProcessSpec {
					return fixtureSpec(cwd);
				}
			}
			const adapter = new FixtureCodexAdapter(drizzle({ client: db }), eventBus);
			const completed = Promise.withResolvers<void>();
			const run = request(cwd, {
				id: "codex-fixture",
				type: "codex",
				capabilities: {
					canonicalPath: binary,
					version: "0.147.0",
					sha256: hash,
					codexHome: cwd,
					consentedAt: new Date().toISOString(),
				},
			});
			run.emit = (event) => {
				if (event.type === "completed") completed.resolve();
			};

			await adapter.launch(run);
			await completed.promise;

			expect(
				JSON.parse(
					(
						db.prepare("SELECT manifest_json FROM run_manifests WHERE run_id = ?").get("run-1") as {
							manifest_json: string;
						}
					).manifest_json,
				),
			).toMatchObject({ executor: "codex", triggerEntryId: "entry-1", sha256: hash });
		},
	);
});
