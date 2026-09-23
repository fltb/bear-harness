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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpProcessSpec } from "../src/executors/acp-client.js";
import { AcpExecutorController } from "../src/executors/acp-executor.js";
import {
	CodexAdapter,
	codexCodeModeHost,
	managedCodexExecutable,
} from "../src/executors/codex-adapter.js";
import { PiAcpAdapter, piWorkerDependencyPaths } from "../src/executors/pi-adapter.js";
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
			config_json TEXT NOT NULL DEFAULT '{}',
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
	it("grants worker dependencies and package metadata without exposing the checkout", () => {
		const root = fixtureDirectory();
		const worker = join(root, "packages", "runtime", "dist", "executors", "worker.js");
		mkdirSync(dirname(worker), { recursive: true });
		writeFileSync(worker, "");
		mkdirSync(join(root, "node_modules"));
		const metadata = join(root, "packages", "runtime", "package.json");
		writeFileSync(metadata, '{"type":"module"}');
		const grants = piWorkerDependencyPaths(worker);
		expect(grants).toContain(join(root, "node_modules"));
		expect(grants).toContain(metadata);
		expect(grants).not.toContain(root);
		expect(grants).not.toContain(dirname(metadata));
		const { system, run, runDb } = createDatabases();
		class InspectablePiAdapter extends PiAcpAdapter {
			spec(input: ExecutorLaunchRequest) {
				return this.processSpec(input);
			}
		}
		try {
			const cwd = join(root, "workspace");
			mkdirSync(cwd);
			const input = request(cwd, { id: "pi-default", type: "pi", capabilities: {} });
			input.task.readOnlyPaths = [join(root, "input.txt")];
			const spec = new InspectablePiAdapter(runDb, join(root, "auth"), worker).spec(input);
			expect(spec.readOnlyPaths).toEqual([join(root, "auth"), ...grants, join(root, "input.txt")]);
		} finally {
			run.close();
			system.close();
		}
	});
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
				credential: { type: "api_key", key: "process-only-secret" },
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
			expect(manifest).toMatchObject({
				schemaVersion: 1,
				executor: "pi-acp",
				workerPath: fixturePath,
			});
			expect(JSON.stringify(manifest)).not.toContain("process-only-secret");
			runDatabase.close();
			system.close();
		},
	);

	it("keeps registration stable across upgrades and verifies old Run snapshots separately", async () => {
		const cwd = fixtureDirectory();
		const oldBinary = join(cwd, "codex-old");
		const newBinary = join(cwd, "codex-new");
		for (const [binary, version] of [
			[oldBinary, "0.149.1"],
			[newBinary, "0.156.0"],
		] as const) {
			writeFileSync(binary, `#!/bin/sh\necho 'codex ${version}'\n`);
			chmodSync(binary, 0o755);
		}
		const candidate = (binary: string, version: string) => ({
			candidatePath: binary,
			canonicalPath: binary,
			version,
			sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
			status: "usable" as const,
		});
		let current = candidate(oldBinary, "0.149.1");
		const { system, run: runDatabase, systemDb, runDb, invalidations } = createDatabases();
		class Adapter extends CodexAdapter {
			override async discover() {
				return [current];
			}
			verify(value: ExecutorLaunchRequest) {
				return this.prepareLaunch(value);
			}
		}
		const adapter = new Adapter(systemDb, runDb, invalidations);
		const launch = vi.spyOn(AcpExecutorController.prototype, "launch").mockResolvedValue();
		try {
			const first = await adapter.consent(current);
			const stored = () =>
				JSON.parse(
					(
						system
							.prepare("SELECT config_json FROM executor_profiles WHERE id = ?")
							.get(first.profileId) as { config_json: string }
					).config_json,
				);
			expect(stored()).not.toHaveProperty("canonicalPath");
			const input = request(cwd, { id: first.profileId, type: "codex", capabilities: stored() });
			await adapter.launch(input);
			const oldSnapshot = launch.mock.calls[0]?.[0];
			if (!oldSnapshot) throw new Error("missing launch snapshot");
			current = candidate(newBinary, "0.156.0");
			expect(await adapter.status()).toMatchObject({
				available: true,
				profileId: first.profileId,
				version: "0.156.0",
			});
			await adapter.launch(input);
			expect(launch.mock.calls[1]?.[0].profile.capabilities).toMatchObject({
				canonicalPath: newBinary,
				version: "0.156.0",
			});
			expect(oldSnapshot.profile.capabilities).toMatchObject({
				canonicalPath: oldBinary,
				version: "0.149.1",
			});
			expect(input.profile.capabilities).not.toHaveProperty("canonicalPath");
			expect((await adapter.consent(current)).profileId).toBe(first.profileId);
			expect(system.prepare("SELECT count(*) AS count FROM executor_profiles").get()).toMatchObject(
				{ count: 1 },
			);
			await adapter.verify(oldSnapshot);
			rmSync(oldBinary);
			await expect(adapter.verify(oldSnapshot)).rejects.toMatchObject({
				kind: "executor_binary_changed",
			});
		} finally {
			launch.mockRestore();
			await adapter.close();
			system.close();
			runDatabase.close();
		}
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
				override async discover() {
					return [
						{
							candidatePath: binary,
							canonicalPath: binary,
							version: "0.149.1",
							sha256: hash,
							status: "usable" as const,
						},
					];
				}

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
			).toMatchObject({
				schemaVersion: 1,
				executor: "codex",
				triggerEntryId: "entry-1",
				sha256: hash,
			});
			runDatabase.close();
			system.close();
		},
	);
});
