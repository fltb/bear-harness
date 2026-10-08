import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const branchPattern =
	/^codex\/upstream-(pi|acp|memory|storage|network|formats|files|render|ui|i18n|desktop|toolchain|infrastructure)$/;
const stable = /^\d+\.\d+\.\d+$/;

export function assertUpdateOnly(path, before, after) {
	if (path === "package-lock.json") {
		const lock = JSON.parse(after);
		assert.equal(lock.lockfileVersion, 3);
		assert(lock.packages);
		return;
	}
	if (path === ".nvmrc") {
		assert(stable.test(after.trim()));
		return;
	}
	if (/^(package\.json|(?:apps|packages)\/[^/]+\/package\.json)$/.test(path)) {
		const a = JSON.parse(before);
		const b = JSON.parse(after);
		for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
			assert.deepEqual(Object.keys(b[field] ?? {}).sort(), Object.keys(a[field] ?? {}).sort());
			for (const [name, value] of Object.entries(a[field] ?? {})) {
				if (value !== b[field][name])
					assert(stable.test(b[field][name]), `Unexpected constraint for ${name}`);
			}
			delete a[field];
			delete b[field];
		}
		if (path === "package.json") {
			const checkOverrides = (old, next) => {
				assert.deepEqual(Object.keys(next ?? {}).sort(), Object.keys(old ?? {}).sort());
				for (const [name, value] of Object.entries(old ?? {})) {
					if (typeof value === "object") checkOverrides(value, next[name]);
					else if (value !== next[name])
						assert(stable.test(next[name]), `Invalid override ${name}`);
				}
			};
			checkOverrides(a.overrides, b.overrides);
			delete a.overrides;
			delete b.overrides;
			for (const field of ["node", "npm"]) {
				assert(stable.test(b.engines[field]));
				a.engines[field] = b.engines[field];
			}
			assert.equal(b.packageManager, `npm@${b.engines.npm}`);
			a.packageManager = b.packageManager;
			// Approved package names and allow/deny decisions cannot change automatically.
			const decisions = (values) =>
				Object.fromEntries(
					Object.entries(values ?? {})
						.map(([key, value]) => [
							key.slice(0, key.lastIndexOf("@") > 0 ? key.lastIndexOf("@") : key.length),
							value,
						])
						.sort(),
				);
			assert.deepEqual(decisions(a.allowScripts), decisions(b.allowScripts));
			delete a.allowScripts;
			delete b.allowScripts;
		}
		assert.deepEqual(b, a, `Non-version manifest change in ${path}`);
		return;
	}
	if (path === "biome.json") {
		const a = JSON.parse(before);
		const b = JSON.parse(after);
		assert(/^https:\/\/biomejs.dev\/schemas\/\d+\.\d+\.\d+\/schema.json$/.test(b.$schema));
		a.$schema = b.$schema;
		assert.deepEqual(b, a);
		return;
	}
	if (path === "config/upstream-binaries.json") {
		const a = JSON.parse(before);
		const b = JSON.parse(after);
		assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort());
		assert.deepEqual(Object.keys(b.actions).sort(), Object.keys(a.actions).sort());
		for (const ref of Object.values(b.actions)) assert(/^v\d+\.\d+\.\d+$/.test(ref));
		assert.deepEqual(Object.keys(b.portableGit).sort(), Object.keys(a.portableGit).sort());
		assert(/^v\d+\.\d+\.\d+\.windows\.\d+$/.test(b.portableGit.tag));
		assert(/^PortableGit-[\d.]+-64-bit\.7z\.exe$/.test(b.portableGit.asset));
		assert(/^[a-f0-9]{64}$/.test(b.portableGit.sha256));
		assert.equal(
			b.portableGit.url,
			`https://github.com/git-for-windows/git/releases/download/${b.portableGit.tag}/${b.portableGit.asset}`,
		);
		return;
	}
	if (/^\.github\/workflows\/[\w-]+\.yml$/.test(path)) {
		const normalize = (text) =>
			text.replace(/(uses: actions\/[\w-]+)@v\d+\.\d+\.\d+/g, "$1@VERSION");
		assert.equal(
			normalize(after),
			normalize(before),
			"Workflow logic cannot change in an automatic update",
		);
		return;
	}
	throw new Error(`Not an automatic dependency update path: ${path}`);
}

export function eligibleRun(run, repository) {
	return (
		run.conclusion === "success" &&
		run.event === "workflow_dispatch" &&
		branchPattern.test(run.head_branch) &&
		run.head_repository?.full_name === repository &&
		run.actor?.login === "github-actions[bot]" &&
		run.path === ".github/workflows/ci.yml"
	);
}

export async function merge() {
	const repository = process.env.GITHUB_REPOSITORY;
	const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
	const run = event.workflow_run;
	if (!eligibleRun(run, repository)) {
		console.log("Not an eligible upstream validation run");
		return;
	}
	async function api(path, method = "GET", body) {
		const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
			method,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${process.env.GH_TOKEN}`,
				"Content-Type": "application/json",
			},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status}`);
		return response.status === 204 ? undefined : response.json();
	}
	return verifyAndMerge(api, run, repository);
}

export async function verifyAndMerge(api, run, repository) {
	assert(eligibleRun(run, repository), "Ineligible validation run");
	const branch = run.head_branch;
	const prs = await api(`pulls?state=open&head=${repository.split("/")[0]}:${branch}&base=main`);
	assert.equal(prs.length, 1, "Expected exactly one dependency PR");
	const pr = prs[0];
	assert.equal(pr.user.login, "github-actions[bot]");
	assert.equal(pr.head.sha, run.head_sha, "The tested head is stale");
	assert.equal(pr.head.repo.full_name, repository);
	const comparison = await api(`compare/main...${run.head_sha}`);
	assert.equal(comparison.behind_by, 0, "Base changed; update and retest before merging");
	const required = new Set([
		"quality",
		"upstream-brand",
		"security",
		"recovery",
		"e2e",
		"web-e2e",
		"release-gate",
	]);
	const jobs = [];
	for (let page = 1; ; page++) {
		const result = await api(`actions/runs/${run.id}/jobs?per_page=100&page=${page}`);
		jobs.push(...result.jobs);
		if (result.jobs.length < 100) break;
	}
	for (const name of required)
		assert(
			jobs.some((job) => job.name === name && job.conclusion === "success"),
			`Missing successful ${name}`,
		);
	assert(
		jobs.filter((job) => job.name.startsWith("package (")).length === 4,
		"All four native package targets must run",
	);
	assert(
		jobs.every((job) => job.conclusion === "success"),
		"Skipped/cancelled/failed checks cannot authorize merging",
	);
	const files = [];
	for (let page = 1; ; page++) {
		const result = await api(`pulls/${pr.number}/files?per_page=100&page=${page}`);
		files.push(...result);
		if (result.length < 100) break;
	}
	assert(files.length > 0 && files.length < 100, "Unexpected update size");
	for (const file of files) {
		assert.equal(file.status, "modified", "Automatic updates cannot add or delete files");
		const content = async (ref) => {
			const value = await api(`contents/${file.filename}?ref=${ref}`);
			assert.equal(value.encoding, "base64");
			return Buffer.from(value.content, "base64").toString();
		};
		assertUpdateOnly(file.filename, await content(pr.base.sha), await content(run.head_sha));
	}
	// A non-forced fast-forward publishes exactly the tested commit. GitHub rejects
	// it atomically if main acquired commits not present in that tested history.
	// Including the PR head in main also marks the PR merged. Repository rules apply.
	const result = await api("git/refs/heads/main", "PATCH", { sha: run.head_sha, force: false });
	assert.equal(result.object.sha, run.head_sha, "The tested commit was not published");
	// GITHUB_TOKEN pushes do not trigger push CI. Validate the new main commit explicitly.
	await api("actions/workflows/ci.yml/dispatches", "POST", { ref: "main" });
	console.log(`Merged verified dependency PR #${pr.number}; main validation dispatched.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await merge();
