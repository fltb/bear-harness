// @vitest-environment node

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyProcessConfinement,
	type ConfinableProcessSpec,
	createMacOSSandboxProfile,
	EXECUTOR_CONFINEMENT_UNAVAILABLE,
} from "../src/executors/confinement.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createRoot(): string {
	const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "bear-confinement-")));
	temporaryDirectories.push(directory);
	return directory;
}

function fixture(): {
	root: string;
	workspace: string;
	output: string;
	home: string;
	temp: string;
	spec: ConfinableProcessSpec;
} {
	const root = createRoot();
	const workspace = join(root, "workspace");
	const output = join(root, "output");
	const home = join(root, "isolated-home");
	const temp = join(root, "isolated-temp");
	for (const path of [workspace, output, home, temp]) mkdirSync(path);
	return {
		root,
		workspace,
		output,
		home,
		temp,
		spec: {
			command: realpathSync.native(process.execPath),
			args: [],
			cwd: workspace,
			env: {
				HOME: home,
				USERPROFILE: home,
				TMPDIR: temp,
				TMP: temp,
				TEMP: temp,
				BEAR_OUTPUT_DIR: output,
			},
		},
	};
}

function thrownBy(operation: () => unknown): unknown {
	try {
		operation();
	} catch (error) {
		return error;
	}
	throw new Error("expected operation to throw");
}

describe("ACP process confinement", () => {
	it("wraps the original argv directly rather than constructing a shell command", () => {
		const { spec } = fixture();
		spec.args = ["argument with spaces", "$(touch should-not-run)"];
		const wrapped = applyProcessConfinement(spec, { platform: "darwin" });

		expect(wrapped.command).toBe("/usr/bin/sandbox-exec");
		expect(wrapped.args.slice(-3)).toEqual([spec.command, ...spec.args]);
	});

	it("allows only the exact consented Codex code-mode helper to execute", () => {
		const { root, spec } = fixture();
		const helper = join(root, "codex-code-mode-host");
		copyFileSync("/usr/bin/true", helper);
		spec.env.BEAR_CODEX_CODE_MODE_HOST_PATH = helper;
		const profile = createMacOSSandboxProfile(spec);
		const executeSection = profile.slice(
			profile.indexOf("(allow process-exec"),
			profile.indexOf("(allow signal"),
		);
		expect(executeSection).toContain(`(literal ${JSON.stringify(helper)})`);
		expect(executeSection).not.toContain(`(subpath ${JSON.stringify(root)})`);
	});

	it.each(["linux", "win32"] as const)(
		"fails closed on %s before an unsupported backend can spawn",
		(platform) => {
			const { spec } = fixture();
			let spawnAttempted = false;
			expect(
				thrownBy(() => {
					const confined = applyProcessConfinement(spec, {
						platform,
						bubblewrapCandidates: [],
					});
					spawnAttempted = true;
					return spawnSync(confined.command, confined.args);
				}),
			).toEqual(EXECUTOR_CONFINEMENT_UNAVAILABLE);
			expect(spawnAttempted).toBe(false);
		},
	);

	it("rejects real lexical escapes and symlinks in granted roots", () => {
		const { root, spec } = fixture();
		const outside = createRoot();
		const target = join(root, "target");
		const link = join(root, "linked-input");
		mkdirSync(target);
		symlinkSync(target, link);

		expect(thrownBy(() => createMacOSSandboxProfile({ ...spec, readOnlyPaths: [link] }))).toEqual({
			kind: "validation_failed",
			reason: "executor_confinement_path_invalid",
		});
		const escapedGrant = `${target}${sep}..${sep}..${sep}${basename(outside)}`;
		expect(resolve(escapedGrant)).toBe(outside);
		expect(
			thrownBy(() =>
				createMacOSSandboxProfile({
					...spec,
					readOnlyPaths: [escapedGrant],
				}),
			),
		).toEqual({ kind: "validation_failed", reason: "executor_confinement_path_invalid" });
	});

	it("rejects a CODEX_HOME grant outside the isolated HOME", () => {
		const { root, spec } = fixture();
		const canonicalCodexHome = join(root, "canonical-codex-home");
		mkdirSync(canonicalCodexHome);

		expect(
			thrownBy(() =>
				createMacOSSandboxProfile({
					...spec,
					env: { ...spec.env, CODEX_HOME: canonicalCodexHome },
				}),
			),
		).toEqual({ kind: "validation_failed", reason: "executor_confinement_path_invalid" });
	});

	it("rejects writable roots inside snapshots before creating them", () => {
		const { root, spec } = fixture();
		const snapshot = join(root, "input-snapshot");
		mkdirSync(snapshot);
		const nestedOutput = join(snapshot, "new-output");

		expect(
			thrownBy(() =>
				createMacOSSandboxProfile({
					...spec,
					readOnlyPaths: [snapshot],
					env: { ...spec.env, BEAR_OUTPUT_DIR: nestedOutput },
				}),
			),
		).toEqual({ kind: "validation_failed", reason: "executor_confinement_path_invalid" });
		expect(existsSync(nestedOutput)).toBe(false);
	});

	it("rejects read-only inputs equal to, containing, or inside the writable private cwd", () => {
		const { root, workspace, spec } = fixture();
		const nestedInput = join(workspace, "user-input");
		mkdirSync(nestedInput);
		for (const readOnlyPath of [workspace, root, nestedInput]) {
			expect(
				thrownBy(() =>
					createMacOSSandboxProfile({
						...spec,
						readOnlyPaths: [readOnlyPath],
					}),
				),
			).toEqual({ kind: "validation_failed", reason: "executor_confinement_path_invalid" });
		}
	});

	it.skipIf(process.platform !== "linux")(
		"keeps declared Linux inputs read-only while the private cwd is writable",
		() => {
			const { root, workspace, spec } = fixture();
			const input = join(root, "declared-input");
			const runtime = createRoot();
			const script = join(runtime, "boundary.mjs");
			mkdirSync(input);
			const inputFile = join(input, "original.txt");
			writeFileSync(inputFile, "preserve-user-input");
			writeFileSync(
				script,
				`
				import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
				const attempt = (fn) => { try { fn(); return true; } catch { return false; } };
				const result = {
					input: readFileSync(process.env.INPUT_FILE, "utf8"),
					write: attempt(() => writeFileSync(process.env.INPUT_FILE, "changed")),
					remove: attempt(() => unlinkSync(process.env.INPUT_FILE)),
					cwd: attempt(() => writeFileSync("worker-result.txt", "private-result")),
				};
				process.stdout.write(JSON.stringify(result));
			`,
			);
			const childSpec = {
				...spec,
				args: [script],
				readOnlyPaths: [input],
				env: { ...spec.env, INPUT_FILE: inputFile },
			};
			const confined = applyProcessConfinement(childSpec);
			const result = spawnSync(confined.command, confined.args, {
				cwd: workspace,
				env: childSpec.env,
				encoding: "utf8",
				timeout: 10_000,
			});
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				input: "preserve-user-input",
				write: false,
				remove: false,
				cwd: true,
			});
			expect(readFileSync(inputFile, "utf8")).toBe("preserve-user-input");
			expect(readFileSync(join(workspace, "worker-result.txt"), "utf8")).toBe("private-result");
		},
	);

	it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
		"enforces the macOS data and executable boundaries in a real child",
		() => {
			const { root, workspace, output, home, temp, spec } = fixture();
			const runtimeRoot = createRoot();
			const runtime = join(runtimeRoot, "runtime");
			const snapshotOne = join(root, "snapshot-one");
			const snapshotTwo = join(root, "snapshot-two");
			const snapshotTwoNested = join(snapshotTwo, "nested");
			const session = join(root, "private-session");
			const unrelatedHome = join(root, "unrelated-home");
			const siblingTemp = join(root, "sibling-temp");
			for (const path of [
				runtime,
				snapshotOne,
				snapshotTwoNested,
				session,
				unrelatedHome,
				siblingTemp,
			]) {
				mkdirSync(path, { recursive: true });
			}
			const script = join(runtime, "boundary.mjs");
			const workspaceFile = join(workspace, "input.txt");
			const snapshotOneFile = join(snapshotOne, "input.txt");
			const snapshotTwoFile = join(snapshotTwoNested, "input.txt");
			const outsideExecutable = join(snapshotOne, "readable-but-not-executable");
			const unrelatedHomeFile = join(unrelatedHome, "secret.txt");
			const siblingTempFile = join(siblingTemp, "secret.txt");
			writeFileSync(workspaceFile, "workspace-readable");
			writeFileSync(snapshotOneFile, "snapshot-one-readable");
			writeFileSync(snapshotTwoFile, "snapshot-two-readable");
			copyFileSync("/usr/bin/true", outsideExecutable);
			writeFileSync(unrelatedHomeFile, "unrelated-home-secret");
			writeFileSync(siblingTempFile, "sibling-temp-secret");
			chmodSync(snapshotOneFile, 0o400);
			chmodSync(outsideExecutable, 0o555);
			writeFileSync(
				script,
				`import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const attempt = (operation) => { try { operation(); return true; } catch { return false; } };
const execute = (path) => attempt(() => {
  const child = spawnSync(path, [], { stdio: "ignore" });
  if (child.error || child.signal || child.status !== 0) throw child.error ?? new Error("execution denied");
});
const result = {
  workspaceRead: attempt(() => readFileSync(process.env.WORKSPACE_FILE, "utf8")),
  snapshotOneRead: attempt(() => readFileSync(process.env.SNAPSHOT_ONE_FILE, "utf8")),
  snapshotTwoRead: attempt(() => readFileSync(process.env.SNAPSHOT_TWO_FILE, "utf8")),
  outsideExecutableRead: attempt(() => readFileSync(process.env.OUTSIDE_EXECUTABLE)),
  outputWrite: attempt(() => writeFileSync(process.env.OUTPUT_FILE, "output-ok")),
  sessionWrite: attempt(() => writeFileSync(process.env.SESSION_FILE, "session-ok")),
  homeWrite: attempt(() => writeFileSync(process.env.HOME_FILE, "home-ok")),
  tempWrite: attempt(() => writeFileSync(process.env.TEMP_FILE, "temp-ok")),
  workspaceWrite: attempt(() => writeFileSync(process.env.WORKSPACE_RESULT, "workspace-ok")),
  snapshotChmod: attempt(() => chmodSync(process.env.SNAPSHOT_ONE_FILE, 0o600)),
  snapshotWrite: attempt(() => writeFileSync(process.env.SNAPSHOT_ONE_FILE, "changed")),
  snapshotDelete: attempt(() => rmSync(process.env.SNAPSHOT_ONE_FILE)),
  unrelatedHomeRead: attempt(() => readFileSync(process.env.UNRELATED_HOME_FILE, "utf8")),
  unrelatedHomeWrite: attempt(() => writeFileSync(process.env.UNRELATED_HOME_FILE, "changed")),
  siblingTempRead: attempt(() => readFileSync(process.env.SIBLING_TEMP_FILE, "utf8")),
  siblingTempWrite: attempt(() => writeFileSync(process.env.SIBLING_TEMP_FILE, "changed")),
  outsideExecution: execute(process.env.OUTSIDE_EXECUTABLE),
};
process.stdout.write(JSON.stringify(result));\n`,
			);
			const childSpec: ConfinableProcessSpec = {
				...spec,
				args: [script],
				readOnlyPaths: [snapshotOne, snapshotTwo],
				env: {
					HOME: home,
					USERPROFILE: home,
					TMPDIR: temp,
					TMP: temp,
					TEMP: temp,
					BEAR_OUTPUT_DIR: output,
					BEAR_PI_SESSION_DIR: session,
					WORKSPACE_FILE: workspaceFile,
					WORKSPACE_RESULT: join(workspace, "result.txt"),
					SNAPSHOT_ONE_FILE: snapshotOneFile,
					SNAPSHOT_TWO_FILE: snapshotTwoFile,
					OUTSIDE_EXECUTABLE: outsideExecutable,
					OUTPUT_FILE: join(output, "result.txt"),
					SESSION_FILE: join(session, "state.json"),
					HOME_FILE: join(home, "preferences.json"),
					TEMP_FILE: join(temp, "scratch.txt"),
					UNRELATED_HOME_FILE: unrelatedHomeFile,
					SIBLING_TEMP_FILE: siblingTempFile,
				},
			};
			const confined = applyProcessConfinement(childSpec);
			const result = spawnSync(confined.command, confined.args, {
				cwd: workspace,
				env: childSpec.env,
				encoding: "utf8",
			});

			if (result.status === null) {
				throw new Error(
					[
						"confined Node terminated without an exit status",
						`signal: ${result.signal ?? "<none>"}`,
						`spawn error: ${result.error?.stack ?? "<none>"}`,
						`stderr: ${result.stderr || "<empty>"}`,
					].join("\n"),
				);
			}
			expect(result.signal).toBeNull();
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				workspaceRead: true,
				snapshotOneRead: true,
				snapshotTwoRead: true,
				outsideExecutableRead: true,
				outputWrite: true,
				sessionWrite: true,
				homeWrite: true,
				tempWrite: true,
				workspaceWrite: true,
				snapshotChmod: false,
				snapshotWrite: false,
				snapshotDelete: false,
				unrelatedHomeRead: false,
				unrelatedHomeWrite: false,
				siblingTempRead: false,
				siblingTempWrite: false,
				outsideExecution: false,
			});
			expect(readFileSync(workspaceFile, "utf8")).toBe("workspace-readable");
			expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe("workspace-ok");
			expect(readFileSync(snapshotOneFile, "utf8")).toBe("snapshot-one-readable");
			expect(statSync(snapshotOneFile).mode & 0o777).toBe(0o400);
			expect(readFileSync(join(output, "result.txt"), "utf8")).toBe("output-ok");
			expect(readFileSync(join(session, "state.json"), "utf8")).toBe("session-ok");
			expect(readFileSync(join(home, "preferences.json"), "utf8")).toBe("home-ok");
			expect(readFileSync(join(temp, "scratch.txt"), "utf8")).toBe("temp-ok");
			expect(readFileSync(unrelatedHomeFile, "utf8")).toBe("unrelated-home-secret");
			expect(readFileSync(siblingTempFile, "utf8")).toBe("sibling-temp-secret");
		},
	);
});
