import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { externalDependencies, manifests } from "./upstream-versions.mjs";

const registry = JSON.parse(await readFile("config/upstream-contracts.json", "utf8"));
const declared = externalDependencies(await manifests());
const registered = new Set();
for (const group of registry.groups) {
	assert(group.evidence.length, `${group.id} has no acceptance evidence`);
	for (const path of group.evidence) await access(path);
	for (const name of group.dependencies) {
		assert(!registered.has(name), `Duplicate dependency registration: ${name}`);
		registered.add(name);
	}
}
assert.deepEqual(
	[...registered].sort(),
	declared,
	"Every external direct dependency must have a tested boundary; remove stale registrations too",
);
const root = JSON.parse(await readFile("package.json", "utf8"));
assert.equal((await readFile(".nvmrc", "utf8")).split("\n")[0], root.engines.node);
assert.equal(root.packageManager, `npm@${root.engines.npm}`);
console.log(
	`${declared.length} external npm dependencies registered in ${registry.groups.length} acceptance groups.`,
);
