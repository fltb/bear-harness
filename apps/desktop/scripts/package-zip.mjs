import { spawn } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

// Resolve the tool through the installed builder so its pinned download and
// checksum policy also applies to our Windows ZIP.
const builderRequire = createRequire(createRequire(import.meta.url).resolve("electron-builder"));

export function runArchive(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`ZIP failed: exit=${code} signal=${signal ?? "none"}`));
		});
	});
}

// NSIS adds resources/elevate.exe after artifactBuildStarted. Freeze the ZIP's
// directory entries first, without copying the already-finalized payload bytes.
// Existing signed application files are read-only throughout artifact creation.
export async function snapshotZipInput(source, destination) {
	const files = [];
	async function visit(from, to) {
		const stat = await lstat(from);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error(`Expected ZIP directory: ${from}`);
		await mkdir(to, { mode: stat.mode });
		for (const entry of await readdir(from, { withFileTypes: true })) {
			const input = join(from, entry.name);
			const output = join(to, entry.name);
			if (entry.isDirectory()) await visit(input, output);
			else if (entry.isSymbolicLink()) await symlink(await readlink(input), output);
			else if (entry.isFile()) files.push([input, output]);
			else throw new Error(`Unsupported ZIP input: ${input}`);
		}
	}
	await visit(source, destination);
	for (let index = 0; index < files.length; index += 16) {
		await Promise.all(files.slice(index, index + 16).map(([from, to]) => link(from, to)));
	}
}

export async function prepareZip({ platform, appPath, file }) {
	await rm(file, { force: true });
	if (platform === "darwin") {
		return {
			command: "zip",
			args: ["-q", "-r", "-y", "-7", file, basename(appPath)],
			cwd: dirname(appPath),
			cleanup: async () => {},
		};
	}
	if (platform !== "win32") throw new Error(`Unsupported ZIP platform: ${platform}`);
	const { getPath7za } = builderRequire("app-builder-lib/out/toolsets/7zip.js");
	const command = await getPath7za();
	const temporary = await mkdtemp(join(dirname(file), ".zip-input-"));
	const cleanup = () => rm(temporary, { recursive: true, force: true });
	try {
		const cwd = join(temporary, "app");
		await snapshotZipInput(appPath, cwd);
		return {
			command,
			args: ["a", "-bd", "-mx=5", "-mtc=off", "-mm=Deflate", "-mcu", file, "."],
			cwd,
			cleanup,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}

export async function writeZip(prepared, file) {
	const started = performance.now();
	console.log(`package phase started: ${file}`);
	try {
		await runArchive(prepared.command, prepared.args, prepared.cwd);
		console.log(
			`package phase finished: ${file} ${((performance.now() - started) / 1000).toFixed(2)}s`,
		);
		return file;
	} catch (error) {
		await rm(file, { force: true });
		throw error;
	} finally {
		await prepared.cleanup();
	}
}
