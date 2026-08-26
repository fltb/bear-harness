// @vitest-environment node

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CANONICAL_DATA_DIRECTORY_NAME,
	DATA_ROOT_MIGRATION_MARKER,
	DATA_ROOT_MIGRATION_STAGING_DIRECTORY,
	LEGACY_DATA_DIRECTORY_NAME,
	resolveDataRoot,
} from "../src/main/data-root-migration.js";
import { RecoveryStateStore, recoveryStateRootForAppData } from "../src/main/recovery-state.js";

const temporaryRoots: string[] = [];

function temporaryAppData(): string {
	const root = mkdtempSync(join(tmpdir(), "bear-data-root-migration-"));
	temporaryRoots.push(root);
	return root;
}

function write(root: string, relativePath: string, content: string, mode = 0o640): void {
	const path = join(root, ...relativePath.split("/"));
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, { mode });
}

const USER_STATE: Record<string, string> = {
	"storage/canon.db": "sqlite-critical-bytes\0\u0001",
	"characters/polar-bear/character.yaml": "name: Polar Bear\n",
	"sessions/session-1.json": '{"messages":["hello"]}\n',
	"artifacts/image.bin": "artifact-bytes",
	"companion-runtime/runtime.json": '{"active":true}\n',
	"memory/index.json": '{"memories":[1]}\n',
	"external-agent-runs/run-1/events.jsonl": '{"event":"started"}\n',
	"audit/events.jsonl": '{"action":"created"}\n',
	"settings.json": '{"theme":"dark"}\n',
};

function seedUserState(root: string): void {
	mkdirSync(root, { recursive: true, mode: 0o750 });
	for (const [relativePath, content] of Object.entries(USER_STATE))
		write(root, relativePath, content);
}

function expectUserState(root: string): void {
	for (const [relativePath, content] of Object.entries(USER_STATE)) {
		expect(readFileSync(join(root, ...relativePath.split("/")))).toEqual(Buffer.from(content));
	}
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveDataRoot", () => {
	it("creates the canonical root when neither root exists", () => {
		const appDataRoot = temporaryAppData();

		const result = resolveDataRoot({ appDataRoot });

		expect(result).toMatchObject({
			status: "ready",
			action: "created",
			root: join(appDataRoot, CANONICAL_DATA_DIRECTORY_NAME),
			legacyRetained: false,
		});
		expect(existsSync(join(appDataRoot, CANONICAL_DATA_DIRECTORY_NAME))).toBe(true);
	});

	it("uses a canonical-only root without requiring a migration marker", () => {
		const appDataRoot = temporaryAppData();
		const canonicalRoot = join(appDataRoot, CANONICAL_DATA_DIRECTORY_NAME);
		write(canonicalRoot, "settings.json", "canonical-only");

		expect(resolveDataRoot({ appDataRoot })).toMatchObject({
			status: "ready",
			action: "canonical",
			root: canonicalRoot,
		});
		expect(readFileSync(join(canonicalRoot, "settings.json"), "utf8")).toBe("canonical-only");
	});

	it("stages, verifies, and activates a byte-identical legacy-only root", () => {
		const appDataRoot = temporaryAppData();
		const legacyRoot = join(appDataRoot, LEGACY_DATA_DIRECTORY_NAME);
		const canonicalRoot = join(appDataRoot, CANONICAL_DATA_DIRECTORY_NAME);
		seedUserState(legacyRoot);

		const result = resolveDataRoot({ appDataRoot });

		expect(result).toMatchObject({
			status: "ready",
			action: "migrated",
			root: canonicalRoot,
			legacyRetained: true,
		});
		expectUserState(canonicalRoot);
		expectUserState(legacyRoot);
		expect(existsSync(join(canonicalRoot, DATA_ROOT_MIGRATION_MARKER))).toBe(true);
		expect(existsSync(join(appDataRoot, DATA_ROOT_MIGRATION_STAGING_DIRECTORY))).toBe(false);
		expect(statSync(join(canonicalRoot, "storage/canon.db")).mode & 0o777).toBe(
			statSync(join(legacyRoot, "storage/canon.db")).mode & 0o777,
		);
	});

	it("uses canonical when both roots exist with a verified completed marker", () => {
		const appDataRoot = temporaryAppData();
		const legacyRoot = join(appDataRoot, LEGACY_DATA_DIRECTORY_NAME);
		seedUserState(legacyRoot);
		expect(resolveDataRoot({ appDataRoot }).status).toBe("ready");

		const result = resolveDataRoot({ appDataRoot });

		expect(result).toMatchObject({
			status: "ready",
			action: "canonical",
			root: join(appDataRoot, CANONICAL_DATA_DIRECTORY_NAME),
			legacyRetained: true,
		});
	});

	it("reports ambiguous roots durably and does not overwrite either root", () => {
		const appDataRoot = temporaryAppData();
		const legacyRoot = join(appDataRoot, LEGACY_DATA_DIRECTORY_NAME);
		const canonicalRoot = join(appDataRoot, CANONICAL_DATA_DIRECTORY_NAME);
		write(legacyRoot, "settings.json", "legacy");
		write(canonicalRoot, "settings.json", "canonical");

		const result = resolveDataRoot({ appDataRoot });

		expect(result).toMatchObject({
			status: "recovery_required",
			reason: "ambiguous_roots",
			canonicalRoot,
			legacyRoot,
			incident: { status: "ok", record: { kind: "root_migration", status: "pending" } },
		});
		expect(readFileSync(join(legacyRoot, "settings.json"), "utf8")).toBe("legacy");
		expect(readFileSync(join(canonicalRoot, "settings.json"), "utf8")).toBe("canonical");
		expect(
			new RecoveryStateStore(recoveryStateRootForAppData(appDataRoot)).get("data-root-migration"),
		).toMatchObject({ status: "ok", record: { status: "pending" } });
	});

	it("recovers a verified staging tree left before activation", () => {
		const appDataRoot = temporaryAppData();
		const legacyRoot = join(appDataRoot, LEGACY_DATA_DIRECTORY_NAME);
		const canonicalRoot = join(appDataRoot, CANONICAL_DATA_DIRECTORY_NAME);
		const stagingRoot = join(appDataRoot, DATA_ROOT_MIGRATION_STAGING_DIRECTORY);
		seedUserState(legacyRoot);
		expect(resolveDataRoot({ appDataRoot }).status).toBe("ready");
		renameSync(canonicalRoot, stagingRoot);

		const result = resolveDataRoot({ appDataRoot });

		expect(result).toMatchObject({
			status: "ready",
			action: "recovered-staging",
			root: canonicalRoot,
			legacyRetained: true,
		});
		expectUserState(canonicalRoot);
		expectUserState(legacyRoot);
		expect(existsSync(stagingRoot)).toBe(false);
	});

	it.skipIf(process.platform === "win32")("rejects symlinks without activating staged data", () => {
		const appDataRoot = temporaryAppData();
		const legacyRoot = join(appDataRoot, LEGACY_DATA_DIRECTORY_NAME);
		const outside = join(appDataRoot, "outside-secret.txt");
		mkdirSync(legacyRoot);
		writeFileSync(outside, "must-not-be-copied");
		symlinkSync(outside, join(legacyRoot, "linked-secret.txt"));

		const result = resolveDataRoot({ appDataRoot });

		expect(result).toMatchObject({ status: "recovery_required", reason: "symlink_rejected" });
		expect(existsSync(join(appDataRoot, CANONICAL_DATA_DIRECTORY_NAME))).toBe(false);
		expect(readFileSync(outside, "utf8")).toBe("must-not-be-copied");
	});

	it("keeps source-E2E overrides isolated from legacy migration", () => {
		const appDataRoot = temporaryAppData();
		const legacyRoot = join(appDataRoot, LEGACY_DATA_DIRECTORY_NAME);
		write(legacyRoot, "settings.json", "production-shaped-fixture");

		const result = resolveDataRoot({ appDataRoot, migrateLegacy: false });

		expect(result).toMatchObject({ status: "ready", action: "test-override" });
		expect(readFileSync(join(legacyRoot, "settings.json"), "utf8")).toBe(
			"production-shaped-fixture",
		);
		expect(readdirSync(join(appDataRoot, CANONICAL_DATA_DIRECTORY_NAME))).toEqual([]);
	});
});
