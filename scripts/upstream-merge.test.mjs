import assert from "node:assert/strict";
import test from "node:test";
import { assertUpdateOnly, eligibleRun, verifyAndMerge } from "./upstream-merge.mjs";

const run = {
	id: 17,
	head_sha: "tested",
	conclusion: "success",
	event: "workflow_dispatch",
	head_branch: "codex/upstream-pi",
	head_repository: { full_name: "owner/repo" },
	actor: { login: "github-actions[bot]" },
	path: ".github/workflows/ci.yml",
};

function repositoryFixture(change = {}) {
	const state = {
		head: "tested",
		behind: 0,
		promotionConflict: false,
		path: "packages/fixture/package.json",
		before: JSON.stringify({ dependencies: { fixture: "1.0.0" } }),
		after: JSON.stringify({ dependencies: { fixture: "2.0.0" } }),
		jobs: [
			"preflight",
			"quality",
			"upstream-brand",
			"security",
			"recovery",
			"e2e",
			"web-e2e",
			"release-gate",
			"package (mac-arm64)",
			"package (mac-x64)",
			"package (win-x64)",
			"package (linux-x64)",
		].map((name) => ({ name, conclusion: "success" })),
		...change,
	};
	const mutations = [];
	const api = async (path, method = "GET", body) => {
		if (method !== "GET") {
			mutations.push({ path, method, body });
			if (path === "git/refs/heads/main") {
				if (state.promotionConflict) throw new Error("Non-fast-forward rejected");
				return { object: { sha: body.sha } };
			}
			assert.equal(path, "actions/workflows/ci.yml/dispatches");
			return;
		}
		if (path.startsWith("pulls?"))
			return [
				{
					number: 3,
					user: { login: "github-actions[bot]" },
					head: { sha: state.head, repo: { full_name: "owner/repo" } },
					base: { sha: "base" },
				},
			];
		if (path.startsWith("compare/")) return { behind_by: state.behind };
		if (path.startsWith("actions/runs/")) return { jobs: state.jobs };
		if (path.startsWith("pulls/3/files")) return [{ filename: state.path, status: "modified" }];
		if (path.startsWith("contents/"))
			return {
				encoding: "base64",
				content: Buffer.from(path.endsWith("ref=base") ? state.before : state.after).toString(
					"base64",
				),
			};
		throw new Error(`Unexpected API request ${path}`);
	};
	return { api, mutations, state };
}
test("publishes exactly the tested commit without forcing main and dispatches its validation", async () => {
	const f = repositoryFixture();
	await verifyAndMerge(f.api, run, "owner/repo");
	assert.deepEqual(f.mutations, [
		{ path: "git/refs/heads/main", method: "PATCH", body: { sha: "tested", force: false } },
		{ path: "actions/workflows/ci.yml/dispatches", method: "POST", body: { ref: "main" } },
	]);
});
test("does not publish a stale PR head", async () => {
	const f = repositoryFixture({ head: "untested" });
	await assert.rejects(verifyAndMerge(f.api, run, "owner/repo"), /stale/);
	assert.equal(f.mutations.length, 0);
});
test("does not publish a candidate behind main", async () => {
	const f = repositoryFixture({ behind: 1 });
	await assert.rejects(verifyAndMerge(f.api, run, "owner/repo"), /Base changed/);
	assert.equal(f.mutations.length, 0);
});
test("requires the named jobs even when the overall run says success", async () => {
	const f = repositoryFixture({ jobs: [] });
	await assert.rejects(verifyAndMerge(f.api, run, "owner/repo"), /Missing successful/);
	assert.equal(f.mutations.length, 0);
});
test("requires all four native package targets", async () => {
	const f = repositoryFixture();
	f.state.jobs.pop();
	await assert.rejects(verifyAndMerge(f.api, run, "owner/repo"), /All four native/);
	assert.equal(f.mutations.length, 0);
});
test("rejects a missing, skipped, cancelled or failed preflight before promotion", async () => {
	for (const conclusion of [null, "skipped", "cancelled", "failure"]) {
		const f = repositoryFixture();
		if (conclusion === null) f.state.jobs = f.state.jobs.filter((job) => job.name !== "preflight");
		else f.state.jobs.find((job) => job.name === "preflight").conclusion = conclusion;
		await assert.rejects(verifyAndMerge(f.api, run, "owner/repo"), /Missing successful preflight/);
		assert.equal(f.mutations.length, 0);
	}
});
test("four green package jobs cannot substitute a duplicate target for a missing platform", async () => {
	const f = repositoryFixture();
	f.state.jobs.find((job) => job.name === "package (linux-x64)").name = "package (win-x64)";
	await assert.rejects(verifyAndMerge(f.api, run, "owner/repo"), /All four native package targets/);
	assert.equal(f.mutations.length, 0);
});
test("does not dispatch main validation after an atomic promotion conflict", async () => {
	const f = repositoryFixture({ promotionConflict: true });
	await assert.rejects(verifyAndMerge(f.api, run, "owner/repo"), /Non-fast-forward/);
	assert.equal(f.mutations.length, 1);
	assert.equal(f.mutations[0].body.force, false);
});
test("rejects passing candidates that rewrite application code", async () => {
	const f = repositoryFixture({ path: "scripts/upstream-merge.mjs" });
	await assert.rejects(verifyAndMerge(f.api, run, "owner/repo"), /Not an automatic/);
	assert.equal(f.mutations.length, 0);
});
test("accepts only a successful bot-dispatched dependency run", () =>
	assert(eligibleRun(run, "owner/repo")));
test("rejects failed, skipped, cancelled and incomplete validation", () => {
	for (const conclusion of ["failure", "skipped", "cancelled", null])
		assert.equal(eligibleRun({ ...run, conclusion }, "owner/repo"), false);
});
test("rejects forks, unrelated branches, workflows and human-dispatched runs", () => {
	for (const change of [
		{ head_repository: { full_name: "fork/repo" } },
		{ head_branch: "main" },
		{ path: ".github/workflows/other.yml" },
		{ actor: { login: "other" } },
		{ event: "pull_request" },
	])
		assert.equal(eligibleRun({ ...run, ...change }, "owner/repo"), false);
});
const manifest = { name: "fixture", dependencies: { a: "1.0.0" }, scripts: { test: "real-test" } };
test("accepts manifest version changes", () =>
	assertUpdateOnly(
		"packages/fixture/package.json",
		JSON.stringify(manifest),
		JSON.stringify({ ...manifest, dependencies: { a: "2.0.0" } }),
	));
test("rejects test command changes hidden beside version updates", () =>
	assert.throws(() =>
		assertUpdateOnly(
			"packages/fixture/package.json",
			JSON.stringify(manifest),
			JSON.stringify({ ...manifest, scripts: { test: "true" } }),
		),
	));
test("rejects dependency additions and non-registry references", () => {
	for (const dependencies of [{ a: "1.0.0", b: "1.0.0" }, { a: "https://example.com/package.tgz" }])
		assert.throws(() =>
			assertUpdateOnly(
				"packages/fixture/package.json",
				JSON.stringify(manifest),
				JSON.stringify({ ...manifest, dependencies }),
			),
		);
});
test("permits only Action version changes in workflows", () => {
	const original = "uses: actions/checkout@v7.0.1\nrun: npm test\n";
	assertUpdateOnly(".github/workflows/ci.yml", original, original.replace("v7.0.1", "v7.0.2"));
	assert.throws(() =>
		assertUpdateOnly(".github/workflows/ci.yml", original, original.replace("npm test", "true")),
	);
});
test("rejects changes to application code or contract assertions", () => {
	for (const path of [
		"packages/host-runtime/src/runtime.ts",
		"scripts/upstream-merge.mjs",
		"config/upstream-contracts.json",
	])
		assert.throws(() => assertUpdateOnly(path, "before", "after"));
});
test("does not allow adding or granting install-script permissions", () => {
	const original = {
		engines: { node: "24.19.0", npm: "11.17.0" },
		packageManager: "npm@11.17.0",
		allowScripts: { "example@1.0.0": false },
	};
	for (const allowScripts of [{ "example@2.0.0": true }, { "other@1.0.0": true }])
		assert.throws(() =>
			assertUpdateOnly(
				"package.json",
				JSON.stringify(original),
				JSON.stringify({ ...original, allowScripts }),
			),
		);
});
