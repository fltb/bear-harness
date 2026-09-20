import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isTransientDmgDetachFailure(result) {
	return (
		result.code !== 0 &&
		!result.signal &&
		/Unable to detach device cleanly: hdiutil: couldn't unmount/.test(result.output) &&
		/(Resource busy|资源忙)/i.test(result.output)
	);
}

/** Retry the packaging operation once, never convert an unsuccessful build into success. */
export async function packageMacWithRecovery(run, report) {
	let result = await run();
	if (isTransientDmgDetachFailure(result)) {
		report(
			"DMG temporary volume was busy; rebuilding once after dmgbuild cleanup. All package checks remain required.",
		);
		result = await run();
	}
	return result;
}

async function main() {
	const arch = process.argv[2];
	if (process.platform !== "darwin" || !["arm64", "x64"].includes(arch)) {
		throw new Error("package-mac requires macOS and an explicit arm64 or x64 target");
	}
	const require = createRequire(import.meta.url);
	const cli = require.resolve("electron-builder/cli.js");
	const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const run = () =>
		new Promise((resolveResult, reject) => {
			const child = spawn(
				process.execPath,
				[cli, "--config", "electron-builder.config.ts", "--mac", "dmg", "zip", `--${arch}`],
				{
					cwd: desktop,
					env: { ...process.env, BEAR_PACKAGE_ARCH: arch },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let output = "";
			for (const [stream, destination] of [
				[child.stdout, process.stdout],
				[child.stderr, process.stderr],
			]) {
				stream.on("data", (chunk) => {
					destination.write(chunk);
					output = (output + chunk.toString()).slice(-64_000);
				});
			}
			child.once("error", reject);
			child.once("close", (code, signal) => resolveResult({ code, signal, output }));
		});
	const result = await packageMacWithRecovery(run, (message) =>
		process.stderr.write(`${message}\n`),
	);
	process.exitCode = result.code ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
