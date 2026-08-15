import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hostPort = process.env.BEAR_WEB_DEV_HOST_PORT ?? "3201";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
for (const workspace of [
	"@bear-harness/product-config",
	"@bear-harness/protocol",
	"@bear-harness/companion-types",
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
const children = [];
let shuttingDown = false;

function run(command, args, env = {}) {
	const child = spawn(command, args, {
		stdio: "inherit",
		env: { ...process.env, ...env, BEAR_WEB_DEV_HOST_PORT: hostPort },
	});
	children.push(child);
	child.once("exit", (code) => {
		if (!shuttingDown) stop(code ?? 1);
	});
	return child;
}

function stop(code) {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const child of children) child.kill("SIGTERM");
	process.exitCode = code;
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

async function start() {
	run(process.execPath, ["server/index.ts"]);
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${hostPort}/bootstrap`);
			if (response.ok) {
				run("npx", ["--no-install", "rsbuild", "dev"]);
				return;
			}
		} catch {
			// The loopback Host has not bound its port yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	process.stderr.write("web-dev: timed out waiting for the loopback Host\n");
	stop(1);
}

void start();
