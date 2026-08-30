// @vitest-environment node

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpProcessSpec } from "../src/executors/acp-client.js";
import { CodexAdapter } from "../src/executors/codex-adapter.js";
import { externalAgentEnvironment } from "../src/executors/environment.js";
import { PiAcpAdapter } from "../src/executors/pi-adapter.js";
import type { ExecutorLaunchRequest } from "../src/executors/router.js";
import { externalAgentResultMessage } from "../src/external-agents/run-service.js";

const temporaryDirectories: string[] = [];

class InspectablePiAdapter extends PiAcpAdapter {
	inspect(request: ExecutorLaunchRequest): AcpProcessSpec {
		return this.processSpec(request);
	}
}

class InspectableCodexAdapter extends CodexAdapter {
	inspect(request: ExecutorLaunchRequest): AcpProcessSpec {
		return this.processSpec(request);
	}
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function fixtureDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "bear-agent-environment-"));
	temporaryDirectories.push(directory);
	return directory;
}

function seedHostileAmbientEnvironment(): void {
	const values: Record<string, string> = {
		PATH: "/safe/runtime/bin",
		LANG: "en_US.UTF-8",
		LC_ALL: "C.UTF-8",
		TMPDIR: "/ambient/tmp",
		HOME: "/real/home",
		USERPROFILE: "C:\\Users\\real-user",
		SSH_AUTH_SOCK: "/private/ssh-agent.sock",
		SSH_PRIVATE_KEY: "ambient-ssh-secret",
		AWS_ACCESS_KEY_ID: "ambient-aws-id",
		AWS_SECRET_ACCESS_KEY: "ambient-aws-secret",
		GITHUB_TOKEN: "ambient-github-secret",
		NPM_TOKEN: "ambient-npm-secret",
		NODE_AUTH_TOKEN: "ambient-node-secret",
		DOCKER_HOST: "ssh://docker-host",
		DOCKER_CONFIG: "/real/home/.docker",
		KUBECONFIG: "/real/home/.kube/config",
		HTTP_PROXY: "http://proxy-user:proxy-secret@proxy.invalid",
		HTTPS_PROXY: "https://proxy-user:proxy-secret@proxy.invalid",
		ALL_PROXY: "socks5://proxy-user:proxy-secret@proxy.invalid",
		OPENAI_API_KEY: "ambient-provider-secret",
		BEAR_PI_API_KEY: "ambient-bear-secret",
		BEAR_HOST_SECRET: "ambient-host-secret",
		CODEX_HOME: "/real/home/.codex",
	};
	for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

function request(root: string, profile: ExecutorLaunchRequest["profile"]): ExecutorLaunchRequest {
	const workspace = join(root, "workspace");
	const outputDirectory = join(root, "run-1", "outputs");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(outputDirectory, { recursive: true });
	return {
		run: { runId: "run-1", triggerEntryId: "entry-1", executorProfile: profile.id },
		task: { instruction: "Inspect the workspace.", workspace, outputDirectory },
		profile,
		emit: () => undefined,
	};
}

function expectNoAmbientSecrets(environment: NodeJS.ProcessEnv): void {
	for (const name of [
		"SSH_AUTH_SOCK",
		"SSH_PRIVATE_KEY",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"GITHUB_TOKEN",
		"NPM_TOKEN",
		"NODE_AUTH_TOKEN",
		"DOCKER_HOST",
		"DOCKER_CONFIG",
		"KUBECONFIG",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"ALL_PROXY",
		"OPENAI_API_KEY",
		"BEAR_HOST_SECRET",
	]) {
		expect(environment).not.toHaveProperty(name);
	}
}

function observeChildEnvironment(spec: AcpProcessSpec): NodeJS.ProcessEnv {
	const child = spawnSync(
		spec.command,
		["--input-type=module", "--eval", "process.stdout.write(JSON.stringify(process.env));"],
		{
			cwd: spec.cwd,
			env: spec.env,
			encoding: "utf8",
		},
	);
	if (child.status !== 0 || child.signal || child.error) {
		throw new Error(
			[
				"environment probe child failed",
				`status: ${child.status ?? "<none>"}`,
				`signal: ${child.signal ?? "<none>"}`,
				`error: ${child.error?.stack ?? "<none>"}`,
				`stderr: ${child.stderr || "<empty>"}`,
			].join("\n"),
		);
	}
	return JSON.parse(child.stdout) as NodeJS.ProcessEnv;
}

function expectPrivateDirectory(directory: string): void {
	expect(statSync(directory).isDirectory()).toBe(true);
	if (process.platform !== "win32") {
		expect(statSync(directory).mode & 0o777).toBe(0o700);
	}
}

describe("external-agent process environments", () => {
	it("inherits only portable runtime values and trusted caller extras", () => {
		seedHostileAmbientEnvironment();

		const environment = externalAgentEnvironment({ EXPLICIT_AGENT_VALUE: "allowed" });

		expect(environment).toMatchObject({
			PATH: "/safe/runtime/bin",
			LANG: "en_US.UTF-8",
			LC_ALL: "C.UTF-8",
			TMPDIR: "/ambient/tmp",
			EXPLICIT_AGENT_VALUE: "allowed",
		});
		expect(environment).not.toHaveProperty("HOME");
		expect(environment).not.toHaveProperty("USERPROFILE");
		expectNoAmbientSecrets(environment);
		expect(environment).not.toHaveProperty("BEAR_PI_API_KEY");
		expect(environment).not.toHaveProperty("CODEX_HOME");
	});

	it("gives Pi a private per-run identity and excludes ambient secrets from the child", () => {
		const root = fixtureDirectory();
		const workerPath = join(root, "pi-acp-worker.js");
		writeFileSync(workerPath, "");
		const canonicalWorkerPath = realpathSync.native(workerPath);
		seedHostileAmbientEnvironment();
		const launch = request(root, { id: "pi-default", type: "pi", capabilities: {} });
		launch.task.modelRoute = {
			providerId: "configured-provider",
			modelId: "configured-model",
			apiKey: "configured-process-only-key",
		};
		const adapter = new InspectablePiAdapter(
			null as never,
			join(root, "user-data"),
			canonicalWorkerPath,
		);
		const spec = adapter.inspect(launch);
		const environment = spec.env;
		const runRoot = realpathSync(join(root, "run-1"));
		const home = realpathSync(join(runRoot, "home"));
		const temporary = realpathSync(join(runRoot, "tmp"));
		const piSessionDirectory = realpathSync(join(runRoot, "pi-session"));
		const piAuthDirectory = realpathSync(join(root, "user-data", "companion-runtime"));
		expect(environment).toMatchObject({
			PATH: "/safe/runtime/bin",
			LANG: "en_US.UTF-8",
			HOME: home,
			USERPROFILE: home,
			TMPDIR: temporary,
			TMP: temporary,
			TEMP: temporary,
			BEAR_PI_PROVIDER_ID: "configured-provider",
			BEAR_PI_MODEL_ID: "configured-model",
			BEAR_PI_API_KEY: "configured-process-only-key",
			BEAR_PI_SESSION_DIR: piSessionDirectory,
			BEAR_PI_AUTH_DIR: piAuthDirectory,
		});
		expectNoAmbientSecrets(environment);
		expect(environment).not.toHaveProperty("CODEX_HOME");
		const observedChildEnvironment = observeChildEnvironment(spec);
		expectNoAmbientSecrets(observedChildEnvironment);
		expect(observedChildEnvironment).toMatchObject({
			HOME: home,
			BEAR_PI_API_KEY: "configured-process-only-key",
		});
		expect(observedChildEnvironment).not.toHaveProperty("CODEX_HOME");
		expectPrivateDirectory(runRoot);
		expectPrivateDirectory(home);
		expectPrivateDirectory(temporary);
		expectPrivateDirectory(environment.BEAR_PI_SESSION_DIR!);
		expectPrivateDirectory(environment.BEAR_PI_AUTH_DIR!);
	});

	it("gives Codex a private per-run identity and excludes ambient secrets from the child", () => {
		const root = fixtureDirectory();
		seedHostileAmbientEnvironment();
		const codexHome = join(root, "configured-codex-home");
		mkdirSync(codexHome, { recursive: true });
		writeFileSync(join(codexHome, "auth.json"), '{"token":"canonical-secret"}\n');
		writeFileSync(join(codexHome, "config.toml"), 'model = "configured-model"\n');
		writeFileSync(join(codexHome, "history.jsonl"), '{"private":"history"}\n');
		mkdirSync(join(codexHome, "sessions"), { recursive: true });
		writeFileSync(join(codexHome, "sessions", "old.jsonl"), '{"private":"session"}\n');
		for (const directory of ["logs", "rules", "skills"]) {
			mkdirSync(join(codexHome, directory), { recursive: true });
		}
		if (process.platform !== "win32") {
			chmodSync(join(codexHome, "auth.json"), 0o600);
			chmodSync(join(codexHome, "config.toml"), 0o640);
		}
		const codexPath = join(root, "bin", "codex");
		const launch = request(root, {
			id: "codex-configured",
			type: "codex",
			capabilities: {
				canonicalPath: codexPath,
				version: "0.147.0",
				sha256: "hash",
				codexHome,
				consentedAt: "2026-08-26T00:00:00.000Z",
			},
		});
		const adapter = new InspectableCodexAdapter(null as never, null as never);
		const spec = adapter.inspect(launch);
		const environment = spec.env;
		const runRoot = realpathSync(join(root, "run-1"));
		const home = realpathSync(join(runRoot, "home"));
		const temporary = realpathSync(join(runRoot, "tmp"));
		const snapshotCodexHome = realpathSync(join(home, ".codex"));
		expect(environment).toMatchObject({
			PATH: "/safe/runtime/bin",
			LANG: "en_US.UTF-8",
			HOME: home,
			USERPROFILE: home,
			TMPDIR: temporary,
			TMP: temporary,
			TEMP: temporary,
			CODEX_HOME: snapshotCodexHome,
			CODEX_PATH: codexPath,
			NO_BROWSER: "1",
		});
		expectNoAmbientSecrets(environment);
		expect(environment).not.toHaveProperty("BEAR_PI_API_KEY");
		const observedChildEnvironment = observeChildEnvironment(spec);
		expectNoAmbientSecrets(observedChildEnvironment);
		expect(observedChildEnvironment).toMatchObject({
			HOME: home,
			CODEX_HOME: snapshotCodexHome,
		});
		expect(observedChildEnvironment).not.toHaveProperty("BEAR_PI_API_KEY");
		expectPrivateDirectory(runRoot);
		expectPrivateDirectory(home);
		expectPrivateDirectory(temporary);
		expectPrivateDirectory(snapshotCodexHome);
		expect(readFileSync(join(snapshotCodexHome, "auth.json"), "utf8")).toContain(
			"canonical-secret",
		);
		expect(readFileSync(join(snapshotCodexHome, "config.toml"), "utf8")).toContain(
			"configured-model",
		);
		expect(existsSync(join(snapshotCodexHome, "history.jsonl"))).toBe(false);
		expect(existsSync(join(snapshotCodexHome, "sessions"))).toBe(false);
		expect(existsSync(join(snapshotCodexHome, "logs"))).toBe(false);
		expect(existsSync(join(snapshotCodexHome, "rules"))).toBe(false);
		expect(existsSync(join(snapshotCodexHome, "skills"))).toBe(false);
		if (process.platform !== "win32") {
			expect(statSync(join(snapshotCodexHome, "auth.json")).mode & 0o777).toBe(0o600);
			expect(statSync(join(snapshotCodexHome, "config.toml")).mode & 0o777).toBe(0o640);
		}
		writeFileSync(join(snapshotCodexHome, "auth.json"), '{"token":"run-only"}\n');
		expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toContain("canonical-secret");
		expect(readFileSync(join(codexHome, "auth.json"), "utf8")).not.toContain("run-only");
	});
});

describe("external-agent result delivery", () => {
	it("returns the settled run summary verbatim instead of asking Pi to rewrite it", () => {
		const message = externalAgentResultMessage({
			run: {
				id: "run-1",
				conversationId: "conversation-1",
				triggerEntryId: "entry-1",
				executorProfile: "codex-profile",
				title: "Read package.json",
				status: "completed",
				startedAt: "2026-08-30T00:00:00.000Z",
				completedAt: "2026-08-30T00:00:01.000Z",
				summary: "The top-level name is `bear-harness`.",
				artifacts: [],
			},
			outputs: [],
		});

		expect(message).toBe(
			"External work completed: Read package.json\n\nThe top-level name is `bear-harness`.",
		);
		expect(message).not.toContain("Give the user");
	});
});
