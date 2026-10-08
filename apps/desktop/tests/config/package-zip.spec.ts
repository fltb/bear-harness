import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareZip, snapshotZipInput, writeZip } from "../../scripts/package-zip.mjs";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "bear-zip-"));
	roots.push(root);
	return root;
}

it("freezes Windows directory entries before NSIS adds its elevation helper", async () => {
	const root = await fixture();
	const source = join(root, "app");
	const destination = join(root, "snapshot");
	await mkdir(join(source, "resources"), { recursive: true });
	await writeFile(join(source, "resources", "app.asar"), "finalized application");
	await snapshotZipInput(source, destination);
	await writeFile(join(source, "resources", "elevate.exe"), "NSIS helper");
	expect(await readFile(join(destination, "resources", "app.asar"), "utf8")).toBe(
		"finalized application",
	);
	await expect(readFile(join(destination, "resources", "elevate.exe"))).rejects.toMatchObject({
		code: "ENOENT",
	});
});

it("creates the Windows ZIP with the builder's pinned 7zip tool and retains Unicode names", async () => {
	const root = await fixture();
	const appPath = join(root, "windows application");
	await mkdir(appPath);
	await writeFile(join(appPath, "角色.txt"), "character resource");
	const file = join(root, "Bear Harness-win-x64.zip");
	const prepared = await prepareZip({ platform: "win32", appPath, file });
	await writeZip(prepared, file);
	const contents = execFileSync(prepared.command, ["l", "-slt", file], { encoding: "utf8" });
	expect(contents).toContain("角色.txt");
	expect(execFileSync(prepared.command, ["t", file], { encoding: "utf8" })).toContain(
		"Everything is Ok",
	);
	await expect(readFile(`${file}.blockmap`)).rejects.toMatchObject({ code: "ENOENT" });
});

it("creates a real Mac ZIP preserving framework links and executable modes without blockmaps", async () => {
	if (process.platform === "win32") return;
	const root = await fixture();
	const appPath = join(root, "Bear Harness.app");
	const framework = join(appPath, "Contents", "Frameworks", "Test.framework");
	await mkdir(join(framework, "Versions", "A"), { recursive: true });
	await writeFile(join(framework, "Versions", "A", "Test"), "executable", { mode: 0o755 });
	await symlink("A", join(framework, "Versions", "Current"));
	await symlink("Versions/Current/Test", join(framework, "Test"));
	const file = join(root, "Bear Harness.zip");
	await writeZip(await prepareZip({ platform: "darwin", appPath, file }), file);
	execFileSync("unzip", ["-t", file]);
	const contents = execFileSync("zipinfo", ["-l", file], { encoding: "utf8" });
	expect(contents).toMatch(/lrwx.*Versions\/Current/);
	expect(contents).toMatch(/-rwx.*Versions\/A\/Test/);
	await expect(readFile(`${file}.blockmap`)).rejects.toMatchObject({ code: "ENOENT" });
});

it("propagates a failed compressor and removes partial output and input snapshot", async () => {
	const root = await fixture();
	const file = join(root, "partial.zip");
	const input = join(root, "input");
	await mkdir(input);
	await writeFile(file, "partial");
	await expect(
		writeZip(
			{
				command: process.execPath,
				args: ["-e", "process.exit(7)"],
				cwd: root,
				cleanup: () => rm(input, { recursive: true }),
			},
			file,
		),
	).rejects.toThrow("exit=7");
	await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(readFile(input)).rejects.toMatchObject({ code: "ENOENT" });
});
