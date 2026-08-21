import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const repoEnv = resolve(repoRoot, ".env");
if (existsSync(repoEnv)) process.loadEnvFile(repoEnv);
for (const workspace of [
	"@bear-harness/product-config",
	"@bear-harness/protocol",
	"@bear-harness/companion-client",
	"@bear-harness/host-runtime",
	"@bear-harness/companion-ui",
]) {
	const result = spawnSync("npm", ["run", "build", "--workspace", workspace], {
		cwd: repoRoot,
		stdio: "inherit",
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}
const children = new Set();
const childFatal = new WeakSet();
let shuttingDown = false;
const dataScope = process.env.BEAR_WEB_DEV_DATA_DIR
	? (process.env.BEAR_WEB_DEV_DATA_SCOPE ?? String(process.pid))
	: undefined;
const fixedHostPort = process.env.BEAR_WEB_DEV_HOST_PORT !== undefined;
const fixedWebPort = process.env.BEAR_WEB_DEV_PORT !== undefined;

function run(command, args, env = {}) {
	const child = spawn(command, args, {
		stdio: "inherit",
		env: {
			...process.env,
			...env,
			BEAR_WEB_DEV_DEBUG: process.env.BEAR_WEB_DEV_DEBUG ?? "1",
		},
	});
	children.add(child);
	child.once("exit", (code) => {
		children.delete(child);
		if (!shuttingDown && childFatal.has(child)) stop(code && code !== 0 ? code : 1);
	});
	return child;
}

function supervise(child) {
	childFatal.add(child);
	if (child.exitCode !== null && !shuttingDown)
		stop(child.exitCode && child.exitCode !== 0 ? child.exitCode : 1);
	return child;
}

function cleanupScopedData() {
	const base = process.env.BEAR_WEB_DEV_DATA_DIR;
	const scope = dataScope;
	const policy = process.env.BEAR_WEB_DEV_DATA_CLEANUP ?? "never";
	if (!base || !scope || !["always", "success"].includes(policy)) return;
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(scope)) return;
	let passed = false;
	const lastRunFile = process.env.BEAR_WEB_DEV_LAST_RUN_FILE;
	if (lastRunFile && existsSync(lastRunFile)) {
		try {
			passed = JSON.parse(readFileSync(lastRunFile, "utf8")).status === "passed";
		} catch {
			passed = false;
		}
	}
	if (policy === "success" && !passed) return;
	const scoped = resolve(base, `.process-${scope}`);
	if (dirname(scoped) !== resolve(base)) return;
	rmSync(scoped, { recursive: true, force: true });
}
function stop(code) {
	if (shuttingDown) return;
	shuttingDown = true;
	const pending = [...children];
	for (const child of pending) child.kill("SIGTERM");
	if (code === 0) {
		if (pending.length === 0) {
			cleanupScopedData();
		} else {
			let remaining = pending.length;
			const afterExit = () => {
				remaining -= 1;
				if (remaining === 0) cleanupScopedData();
			};
			for (const child of pending) child.once("exit", afterExit);
		}
	}
	process.exitCode = code;
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

async function start() {
	const baseHostPort = Number(process.env.BEAR_WEB_DEV_HOST_PORT ?? "3201");
	const baseWebPort = Number(process.env.BEAR_WEB_DEV_PORT ?? "3200");
	const deadline = Date.now() + 30_000;
	const host = await launchWithRetry({
		startPort: baseHostPort,
		command: process.execPath,
		args: ["server/index.ts"],
		env: {
			...(dataScope ? { BEAR_WEB_DEV_DATA_SCOPE: dataScope } : {}),
		},
		reserved: new Set(),
		path: "bootstrap",
		label: "loopback Host",
		deadline,
		fixedPort: fixedHostPort,
	});
	const web = await launchWithRetry({
		startPort: baseWebPort,
		command: "npx",
		args: ["--no-install", "rsbuild", "dev"],
		env: {
			BEAR_WEB_DEV_HOST_PORT: String(host.port),
			...(dataScope ? { BEAR_WEB_DEV_DATA_SCOPE: dataScope } : {}),
		},
		reserved: new Set([host.port]),
		path: "bootstrap",
		label: "UI proxy",
		deadline,
		fixedPort: fixedWebPort,
	});
	process.stdout.write(`web-dev UI ready: http://127.0.0.1:${web.port}\n`);
}

async function launchWithRetry({
	startPort,
	command,
	args,
	env,
	reserved,
	path,
	label,
	deadline,
	fixedPort,
}) {
	if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65_535) {
		throw new Error(`invalid ${label} port: ${startPort}`);
	}
	const maxAttempts = fixedPort ? 1 : 20;
	for (let attempt = 0; attempt < maxAttempts && startPort + attempt <= 65_535; attempt += 1) {
		const port = startPort + attempt;
		if (reserved.has(port)) continue;
		const childEnv = { ...env };
		if (label === "loopback Host") childEnv.BEAR_WEB_DEV_HOST_PORT = String(port);
		if (label === "UI proxy") childEnv.BEAR_WEB_DEV_PORT = String(port);
		const child = run(command, args, childEnv);
		const result = await waitForJsonBootstrap(`http://127.0.0.1:${port}/${path}`, deadline, child);
		if (result === "ready") return { child: supervise(child), port };
		if (result === "timeout") {
			child.kill("SIGTERM");
			throw new Error(`timed out waiting for the ${label} on port ${port}`);
		}
		if (fixedPort) {
			throw new Error(
				`unable to start the ${label} on configured port ${port}; the child exited before serving /${path}`,
			);
		}
	}
	throw new Error(
		fixedPort
			? `unable to start the ${label} on configured port ${startPort}`
			: `unable to start the ${label} after bounded port retries`,
	);
}

async function waitForJsonBootstrap(url, deadline, child) {
	return new Promise((resolveResult) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			child.removeListener("exit", onExit);
			resolveResult(result);
		};
		const onExit = () => finish("exited");
		child.once("exit", onExit);
		const poll = async () => {
			while (!settled && Date.now() < deadline) {
				try {
					const response = await fetch(url, {
						cache: "no-store",
						signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, deadline - Date.now()))),
					});
					if (
						response.ok &&
						(response.headers.get("content-type") ?? "").includes("application/json")
					) {
						const payload = await response.json();
						if (
							payload &&
							typeof payload === "object" &&
							typeof payload.token === "string" &&
							payload.product &&
							typeof payload.product === "object"
						) {
							finish("ready");
							return;
						}
					}
				} catch {
					// The target has not bound its port or has not finished proxying yet.
				}
				await new Promise((resume) => setImmediate(resume));
			}
			finish("timeout");
		};
		void poll();
	});
}

void start().catch((error) => {
	process.stderr.write(`web-dev: ${error instanceof Error ? error.message : String(error)}\n`);
	stop(1);
});
