import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RunnerProfiles } from "../src/executors/profiles.js";
import { CredentialStore } from "../src/providers/credential-store.js";
import { SYSTEM_SCHEMA_SQL, SystemDatabase } from "../src/storage/database.js";
import { executorProfiles } from "../src/storage/schema.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "bear-runners-"));
	const database = new SystemDatabase(join(root, "settings.db"));
	database.initialize(SYSTEM_SCHEMA_SQL);
	const credentials = new CredentialStore(database.orm, {
		securityLevel: "session",
		isEncryptionAvailable: () => false,
		encryptString: () => {
			throw new Error("No vault");
		},
		decryptString: () => {
			throw new Error("No vault");
		},
	});
	cleanups.push(() => {
		database.close();
		rmSync(root, { recursive: true, force: true });
	});
	return { database, credentials, profiles: new RunnerProfiles(database.orm, credentials) };
}
const config = {
	name: "Research",
	description: "Research worker",
	useWhen: "For research",
	limitations: "No browser",
	enabled: true,
	configuration: {
		command: realpathSync(process.execPath),
		args: ["worker.mjs"],
		environment: [{ name: "API_KEY", value: "private-test-secret", secret: true }],
		dependencyPaths: [],
	},
};
it("projects only selection metadata to the model and stores custom secrets only in the vault", async () => {
	const { profiles, database } = fixture();
	const saved = await profiles.save(config);
	expect(saved.kind).toBe("custom");
	expect(saved.configuration?.environment).toEqual([{ name: "API_KEY", secret: true }]);
	expect(JSON.stringify(database.orm.select().from(executorProfiles).all())).not.toContain(
		"private-test-secret",
	);
	expect(profiles.configuration(profiles.get(saved.runnerId)).environment[0]?.value).toBe(
		"private-test-secret",
	);
	expect(profiles.catalog().find((item) => item.runnerId === saved.runnerId)).toEqual({
		runnerId: saved.runnerId,
		kind: "custom",
		name: "Research",
		description: "Research worker",
		useWhen: "For research",
		limitations: "No browser",
		enabled: true,
		configured: true,
	});
	const edited = await profiles.save({
		...config,
		runnerId: saved.runnerId,
		configuration: { ...config.configuration, environment: [{ name: "API_KEY", secret: true }] },
	});
	expect(edited.configuration?.environment[0]).not.toHaveProperty("value");
	expect(profiles.configuration(profiles.get(saved.runnerId)).environment[0]?.value).toBe(
		"private-test-secret",
	);
});
it("keeps the built-in default enabled and excludes disabled custom runners from the model catalog", async () => {
	const { profiles } = fixture();
	await expect(
		profiles.save({ ...config, runnerId: "pi-default", enabled: false, configuration: undefined }),
	).rejects.toMatchObject({ reason: "default_runner_cannot_be_disabled" });
	const saved = await profiles.save({ ...config, enabled: false });
	expect(profiles.catalog().some((item) => item.runnerId === saved.runnerId)).toBe(false);
});
it("rejects isolation overrides and missing executables before saving a profile", async () => {
	const { profiles } = fixture();
	const before = profiles.list();
	await expect(
		profiles.save({
			...config,
			configuration: {
				...config.configuration,
				environment: [{ name: "HOME", value: "/", secret: false }],
			},
		}),
	).rejects.toMatchObject({ reason: "runner_environment_invalid" });
	await expect(
		profiles.save({
			...config,
			configuration: { ...config.configuration, command: "/missing/bear-worker" },
		}),
	).rejects.toMatchObject({ reason: "runner_executable_not_found" });
	expect(profiles.list()).toEqual(before);
});

it("converts the previous executor profile storage once without losing identity or configuration", () => {
	const root = mkdtempSync(join(tmpdir(), "bear-runner-schema-"));
	const database = new SystemDatabase(join(root, "settings.db"));
	cleanups.push(() => {
		database.close();
		rmSync(root, { recursive: true, force: true });
	});
	const previous = SYSTEM_SCHEMA_SQL.replace("'pi','codex','custom'", "'pi','codex'").replaceAll(
		"config_json",
		"capability_json",
	);
	database.connection.exec(previous);
	database.connection.exec("PRAGMA user_version=1");
	database.connection
		.prepare("INSERT INTO executor_profiles(id,profile_type,capability_json) VALUES(?,?,?)")
		.run(
			"codex-saved",
			"codex",
			JSON.stringify({
				canonicalPath: "/usr/bin/codex",
				version: "0.149.1",
				sha256: "old",
				codexHome: "/home/test/.codex",
				consentedAt: "2026-09-23",
				enabled: false,
			}),
		);
	database.initialize(SYSTEM_SCHEMA_SQL);
	database.initialize(SYSTEM_SCHEMA_SQL);
	expect(
		database.connection
			.prepare("SELECT id,config_json FROM executor_profiles WHERE id='codex-saved'")
			.get(),
	).toEqual({
		id: "codex-saved",
		config_json: JSON.stringify({
			codexHome: "/home/test/.codex",
			consentedAt: "2026-09-23",
			enabled: false,
		}),
	});
	database.orm
		.insert(executorProfiles)
		.values({ id: "custom-new", profileType: "custom", configJson: {} })
		.run();
	expect(database.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
