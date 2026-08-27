import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const stage = process.argv[2];
const allowed = new Set([
	"quality",
	"recovery",
	"electron-e2e",
	"web-e2e",
	"live-model",
	"package",
	"final",
]);
if (!allowed.has(stage))
	throw new Error(`unknown release attestation stage: ${stage ?? "<missing>"}`);

const root = resolve("release-attestations");
mkdirSync(root, { recursive: true });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
const target = process.env.RELEASE_TARGET ?? `${process.platform}-${process.arch}`;

if (stage === "final") {
	const required = ["quality", "recovery", "electron-e2e", "web-e2e", "live-model"];
	for (const name of required) {
		const path = resolve(root, `${name}.json`);
		if (!existsSync(path)) throw new Error(`missing release attestation: ${name}`);
		const record = JSON.parse(readFileSync(path, "utf8"));
		if (record.commit !== commit || record.status !== "passed") {
			throw new Error(`invalid ${name} attestation for commit ${commit}`);
		}
	}
	const packages = ["mac-x64", "mac-arm64", "win-x64", "linux-x64"];
	for (const name of packages) {
		const path = resolve(root, `package-${name}.json`);
		if (!existsSync(path)) throw new Error(`missing packaged release attestation: ${name}`);
		const record = JSON.parse(readFileSync(path, "utf8"));
		if (record.commit !== commit || record.status !== "passed") {
			throw new Error(`invalid package-${name} attestation for commit ${commit}`);
		}
	}
}

const record = {
	schema: 1,
	stage,
	status: "passed",
	commit,
	target,
	dirty: dirty.length > 0,
	createdAt: new Date().toISOString(),
};
const body = `${JSON.stringify(record, null, 2)}\n`;
const suffix = stage === "package" ? `-${target}` : "";
const path = resolve(root, `${stage}${suffix}.json`);
const temporary = `${path}.tmp-${process.pid}`;
writeFileSync(temporary, body, { flush: true });
renameSync(temporary, path);
console.log(JSON.stringify({ ...record, sha256: createHash("sha256").update(body).digest("hex") }));
