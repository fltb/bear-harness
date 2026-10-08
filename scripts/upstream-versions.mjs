import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
export async function manifests() {
	const paths = ["package.json"];
	for (const root of ["apps", "packages"]) {
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = `${root}/${entry.name}/package.json`;
			try {
				await readFile(path);
				paths.push(path);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
	}
	return Promise.all(
		paths.map(async (path) => ({ path, data: JSON.parse(await readFile(path, "utf8")) })),
	);
}

export function externalDependencies(packages) {
	return [
		...new Set(
			packages.flatMap(({ data }) =>
				["dependencies", "devDependencies", "optionalDependencies"].flatMap((field) =>
					Object.entries(data[field] ?? {})
						.filter(([, version]) => !/^(file:|workspace:)/.test(version))
						.map(([name]) => name),
				),
			),
		),
	].sort();
}

export function newer(current, candidate) {
	if (!/^\d+\.\d+\.\d+$/.test(candidate)) throw new Error(`Not a stable release: ${candidate}`);
	const old = current.replace(/^[~^]/, "").match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
	if (!old) throw new Error(`Unsupported version constraint: ${current}`);
	const next = candidate.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (next[i] !== Number(old[i + 1])) return next[i] > Number(old[i + 1]);
	}
	return Boolean(old[4]);
}

export function updateManifest(data, versions) {
	const result = structuredClone(data);
	for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
		for (const [name, version] of Object.entries(result[field] ?? {})) {
			if (versions[name] && newer(version, versions[name])) result[field][name] = versions[name];
		}
	}
	function updateOverrides(overrides) {
		for (const [name, value] of Object.entries(overrides ?? {})) {
			if (typeof value === "object") updateOverrides(value);
			else if (versions[name] && newer(value, versions[name])) overrides[name] = versions[name];
		}
	}
	updateOverrides(result.overrides);
	if (result.allowScripts) {
		for (const [key, allowed] of Object.entries(data.allowScripts)) {
			const split = key.lastIndexOf("@");
			if (split <= 0) continue;
			const name = key.slice(0, split);
			const version = versions[name];
			if (version && newer(key.slice(split + 1), version))
				result.allowScripts[`${name}@${version}`] = allowed;
		}
	}
	return result;
}

async function npmVersion(name) {
	if (!process.env.npm_execpath)
		throw new Error("Run with fnm exec --using=.nvmrc npm run upstream:update");
	const { stdout } = await execute(
		process.execPath,
		[process.env.npm_execpath, "view", name, "version", "--json"],
		{ timeout: 90_000, maxBuffer: 1024 * 1024 },
	);
	const value = JSON.parse(stdout);
	return Array.isArray(value) ? value.at(-1) : value;
}

async function github(path) {
	const response = await fetch(`https://api.github.com/repos/${path}`, {
		headers: {
			Accept: "application/vnd.github+json",
			...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
		},
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`GitHub metadata ${path}: ${response.status}`);
	return response.json();
}

export function portableGitRelease(release) {
	if (
		release.draft ||
		release.prerelease ||
		!/^v\d+\.\d+\.\d+\.windows\.\d+$/.test(release.tag_name)
	)
		throw new Error("Invalid PortableGit release");
	const asset = release.assets.find((item) =>
		/^PortableGit-[\d.]+-64-bit\.7z\.exe$/.test(item.name),
	);
	if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ""))
		throw new Error("PortableGit release has no verifiable archive digest");
	const url = `https://github.com/git-for-windows/git/releases/download/${release.tag_name}/${asset.name}`;
	if (asset.browser_download_url !== url) throw new Error("Unexpected PortableGit asset URL");
	return { tag: release.tag_name, asset: asset.name, url, sha256: asset.digest.slice(7) };
}

export function selectDependencies(packages, registry, group, overrides) {
	if (group === "all") return [...new Set([...externalDependencies(packages), ...overrides])];
	if (group === "infrastructure") return [...new Set(overrides)];
	const selected = registry.groups.find((entry) => entry.id === group);
	if (!selected) throw new Error(`Unknown dependency group: ${group}`);
	return selected.dependencies;
}

export async function update(group = process.argv[2] ?? "all") {
	const packages = await manifests();
	const overrideNames = [];
	function collect(overrides) {
		for (const [name, value] of Object.entries(overrides ?? {})) {
			if (typeof value === "object") collect(value);
			else overrideNames.push(name);
		}
	}
	for (const { data } of packages) collect(data.overrides);
	const registry = JSON.parse(await readFile("config/upstream-contracts.json", "utf8"));
	const names = selectDependencies(packages, registry, group, overrideNames);
	const infrastructure = group === "all" || group === "infrastructure";
	const versions = {};
	for (let i = 0; i < names.length; i += 6) {
		await Promise.all(
			names.slice(i, i + 6).map(async (name) => {
				versions[name] = await npmVersion(name);
			}),
		);
	}
	const nodeVersion = infrastructure ? await npmVersion("node") : undefined;
	const npm = infrastructure ? await npmVersion("npm") : undefined;
	const binaries = JSON.parse(await readFile("config/upstream-binaries.json", "utf8"));
	const previousActions = { ...binaries.actions };
	for (const name of infrastructure ? Object.keys(binaries.actions) : []) {
		const release = await github(`${name}/releases/latest`);
		const version = release.tag_name?.replace(/^v/, "");
		if (release.draft || release.prerelease) throw new Error(`Unstable action ${name}`);
		if (newer(binaries.actions[name].slice(1), version)) binaries.actions[name] = `v${version}`;
	}
	if (infrastructure)
		binaries.portableGit = portableGitRelease(await github("git-for-windows/git/releases/latest"));
	const changes = [];
	for (const { path, data } of packages) {
		const updated = updateManifest(data, versions);
		if (path === "package.json" && infrastructure) {
			if (newer(data.engines.node, nodeVersion)) updated.engines.node = nodeVersion;
			if (newer(data.engines.npm, npm)) updated.engines.npm = npm;
			updated.packageManager = `npm@${updated.engines.npm}`;
			await writeFile(".nvmrc", `${updated.engines.node}\n`);
		}
		if (JSON.stringify(updated) !== JSON.stringify(data)) {
			await writeFile(path, `${JSON.stringify(updated, null, "\t")}\n`);
			changes.push(path);
		}
	}
	for (const file of await readdir(".github/workflows")) {
		if (!file.endsWith(".yml")) continue;
		const path = `.github/workflows/${file}`;
		let content = await readFile(path, "utf8");
		for (const [name, old] of Object.entries(previousActions))
			content = content.replaceAll(`${name}@${old}`, `${name}@${binaries.actions[name]}`);
		await writeFile(path, content);
	}
	await writeFile("config/upstream-binaries.json", `${JSON.stringify(binaries, null, "\t")}\n`);
	if (versions["@biomejs/biome"]) {
		const biomeSource = await readFile("biome.json", "utf8");
		const schema = JSON.parse(biomeSource).$schema;
		await writeFile(
			"biome.json",
			biomeSource.replace(
				JSON.stringify(schema),
				JSON.stringify(`https://biomejs.dev/schemas/${versions["@biomejs/biome"]}/schema.json`),
			),
		);
	}
	console.log(
		JSON.stringify({ group, packages: names.length, changedManifests: changes, versions }, null, 2),
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await update();
