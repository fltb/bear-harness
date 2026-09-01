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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AcpProcessSpec } from "../src/executors/acp-client.js";
import {
	CodexAdapter,
	codexCodeModeHost,
	managedCodexExecutable,
} from "../src/executors/codex-adapter.js";
import { PiAcpAdapter, piModelEnvironment } from "../src/executors/pi-adapter.js";
import type { ExecutorLaunchRequest } from "../src/executors/router.js";
import { InvalidationHub } from "../src/storage/invalidation-hub.js";

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

function createDatabases() {
	const system = new DatabaseSync(":memory:");
	const run = new DatabaseSync(":memory:");
	system.exec(`
		CREATE TABLE executor_profiles (
			id TEXT PRIMARY KEY,
			profile_type TEXT NOT NULL,
			capability_json TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
	run.exec(`
		CREATE TABLE run_manifests (
			id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			manifest_json TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
	const systemDb = drizzle({ client: system });
	const runDb = drizzle({ client: run });
	return { system, run, systemDb, runDb, invalidations: new InvalidationHub() };
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
	it("resolves the managed npm Codex launcher to its exact native binary", () => {
		const resolver = createRequire(import.meta.url);
		const launcher = resolver.resolve("@openai/codex/bin/codex.js");
		const executable = managedCodexExecutable(launcher);
		expect(executable).not.toBeNull();
		if (executable === null) throw new Error("managed Codex binary was not installed");
		expect(executable).not.toBe(launcher);
		expect(executable).toMatch(/[/\\]vendor[/\\].*[/\\]bin[/\\]codex(?:\.exe)?$/);
		expect(codexCodeModeHost(executable)).toMatch(
			/[/\\]vendor[/\\].*[/\\]bin[/\\]codex-code-mode-host(?:\.exe)?$/,
		);
	});

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
			const { system, run: runDatabase, runDb } = createDatabases();
			const adapter = new PiAcpAdapter(runDb, join(root, "user-data"), fixturePath);
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
					runDatabase
						.prepare("SELECT manifest_json FROM run_manifests WHERE run_id = ?")
						.get("run-1") as { manifest_json: string }
				).manifest_json,
			) as Record<string, unknown>;
			expect(manifest).toMatchObject({ executor: "pi-acp", workerPath: fixturePath });
			expect(JSON.stringify(manifest)).not.toContain("apiKey");
			runDatabase.close();
			system.close();
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
			const codeModeHost = join(cwd, "codex-code-mode-host");
			writeFileSync(binary, "#!/bin/sh\necho 'codex 0.149.1'\n");
			writeFileSync(codeModeHost, "#!/bin/sh\nexit 0\n");
			chmodSync(binary, 0o755);
			chmodSync(codeModeHost, 0o755);
			const hash = createHash("sha256").update(readFileSync(binary)).digest("hex");
			const codeModeHostHash = createHash("sha256")
				.update(readFileSync(codeModeHost))
				.digest("hex");
			const { system, run: runDatabase, systemDb, runDb, invalidations } = createDatabases();
			class FixtureCodexAdapter extends CodexAdapter {
				protected override processSpec(): AcpProcessSpec {
					return fixtureSpec(cwd);
				}
			}
			const adapter = new FixtureCodexAdapter(systemDb, runDb, invalidations);
			const completed = Promise.withResolvers<void>();
			const run = request(cwd, {
				id: "codex-fixture",
				type: "codex",
				capabilities: {
					canonicalPath: binary,
					version: "0.149.1",
					sha256: hash,
					codeModeHostPath: codeModeHost,
					codeModeHostSha256: codeModeHostHash,
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
						runDatabase
							.prepare("SELECT manifest_json FROM run_manifests WHERE run_id = ?")
							.get("run-1") as { manifest_json: string }
					).manifest_json,
				),
			).toMatchObject({ executor: "codex", triggerEntryId: "entry-1", sha256: hash });
			runDatabase.close();
			system.close();
		},
	);
});
