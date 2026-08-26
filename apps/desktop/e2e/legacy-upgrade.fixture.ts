import { createHash } from "node:crypto";
import {
	cpSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
	type PiSessionMessage,
	PiSessionStore,
} from "../../../packages/host-runtime/src/companion/pi-session-store.js";
import { AuditStore } from "../../../packages/host-runtime/src/security/audit-store.js";
import { Database, MIGRATIONS } from "../../../packages/host-runtime/src/storage/database.js";

const characterSeed = fileURLToPath(new URL("../../../config/characters/jizhou", import.meta.url));

export const LEGACY_UPGRADE = Object.freeze({
	legacyDirectoryName: "cyber-bear",
	canonicalDirectoryName: "bear-harness",
	characterId: "jizhou",
	conversationId: "legacy-conversation",
	conversationTitle: "迁移前的雪夜交谈",
	conversationUserText: "迁移前我把旧车票放在了值守台上。",
	conversationAssistantText: "极昼把旧车票收进透明封套，标记为待归档。",
	attachmentId: "legacy-attachment",
	attachmentName: "旧站交接记录.txt",
	attachmentText: "旧站交接记录：迁移后仍可读取的附件。",
	providerId: "legacy-relay",
	modelId: "legacy-model",
	modelLabel: "Legacy Relay Model",
	memoryCandidateId: "legacy-memory-candidate",
	memoryText: "用户希望每次交接都保留旧车票。",
	auditAction: "legacy-upgrade-sentinel",
	auditDetail: "audit sentinel written before the data-root upgrade",
});

export type ByteSnapshot = Readonly<Record<string, string>>;

export interface LegacyUpgradeFixture {
	readonly appDataRoot: string;
	readonly legacyRoot: string;
	readonly canonicalRoot: string;
	readonly legacyBeforeLaunch: ByteSnapshot;
	readonly sessionFileRelativePath: string;
	readonly artifactSha256: string;
	readonly priorSchemaVersion: number;
	readonly targetSchemaVersion: number;
}

function sha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function collectBytes(root: string, directory: string, output: Record<string, string>): void {
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const path = join(directory, entry.name);
		const key = relative(root, path).replaceAll("\\", "/");
		if (entry.isDirectory()) {
			collectBytes(root, path, output);
		} else if (entry.isSymbolicLink()) {
			output[key] = sha256(`symlink\0${readlinkSync(path)}`);
		} else if (entry.isFile()) {
			output[key] = sha256(readFileSync(path));
		}
	}
}

export function snapshotTreeBytes(root: string): ByteSnapshot {
	const output: Record<string, string> = {};
	collectBytes(root, root, output);
	return Object.freeze(output);
}

function insertLegacyRows(
	database: Database,
	legacyRoot: string,
	canonicalRoot: string,
	sessionFile: string,
	piSessionId: string,
	userEntryId: string,
	assistantEntryId: string,
	artifactSha256: string,
): void {
	const db = database.connection;
	const canonicalSessionFile = join(canonicalRoot, relative(legacyRoot, sessionFile));
	const onboarding = JSON.stringify({
		schema_version: 1,
		flow_version: 5,
		answers: { nickname: "旧站旅客" },
		decisions: {
			relationship_memory_enabled: true,
			conversation_history_read_enabled: true,
			roleplay_initial_values: {},
		},
	});

	db.exec("BEGIN IMMEDIATE");
	try {
		db.prepare(
			"INSERT INTO companion_packages (id, name, version, hash, origin, plugin_hash, plugin_trusted_hash) VALUES (?, ?, ?, ?, 'official', ?, ?)",
		).run(LEGACY_UPGRADE.characterId, "极昼", "3.0.0", "legacy-package-hash", "", "");
		db.prepare(
			"INSERT INTO companion_identity (id, package_id, name, self_canon, nickname) VALUES (?, ?, ?, ?, ?)",
		).run(
			LEGACY_UPGRADE.characterId,
			LEGACY_UPGRADE.characterId,
			"极昼",
			"旧站迁移前保存的角色自我设定。",
			"旧站旅客",
		);
		db.prepare(
			"INSERT INTO self_canon_versions (companion_id, canon, version, hash) VALUES (?, ?, 1, ?)",
		).run(
			LEGACY_UPGRADE.characterId,
			"旧站迁移前保存的角色自我设定。",
			sha256("legacy-self-canon"),
		);
		db.prepare(
			"INSERT INTO conversations (id, companion_id, title, scene_title) VALUES (?, ?, ?, ?)",
		).run(
			LEGACY_UPGRADE.conversationId,
			LEGACY_UPGRADE.characterId,
			LEGACY_UPGRADE.conversationTitle,
			"旧站值守台",
		);
		db.prepare(
			"INSERT INTO active_conversations (companion_id, conversation_id) VALUES (?, ?)",
		).run(LEGACY_UPGRADE.characterId, LEGACY_UPGRADE.conversationId);
		db.prepare(
			"INSERT INTO conversation_sessions (conversation_id, pi_session_id, session_file_path) VALUES (?, ?, ?)",
		).run(LEGACY_UPGRADE.conversationId, piSessionId, canonicalSessionFile);
		db.prepare(
			"INSERT INTO onboarding_state (companion_id, state, state_json) VALUES (?, 'complete', ?)",
		).run(LEGACY_UPGRADE.characterId, onboarding);
		db.prepare(
			"INSERT INTO configured_models (provider_id, model_id, label, supports_images) VALUES (?, ?, ?, 0)",
		).run(LEGACY_UPGRADE.providerId, LEGACY_UPGRADE.modelId, LEGACY_UPGRADE.modelLabel);
		db.prepare(
			"INSERT INTO model_route_settings (companion_id, text_provider_id, text_model_id, vision_mode) VALUES (?, ?, ?, 'auto')",
		).run(LEGACY_UPGRADE.characterId, LEGACY_UPGRADE.providerId, LEGACY_UPGRADE.modelId);
		db.prepare(
			"INSERT INTO conversation_model_selections (conversation_id, provider_id, model_id) VALUES (?, ?, ?)",
		).run(LEGACY_UPGRADE.conversationId, LEGACY_UPGRADE.providerId, LEGACY_UPGRADE.modelId);
		db.prepare(
			`INSERT INTO relationship_memory_entries
				(id, companion_id, kind, scope, text, normalized_text, source_pi_session_id,
				 source_native_entry_id, source_conversation_id, source_kind, status)
			 VALUES (?, ?, 'preference', 'relationship', ?, ?, ?, ?, ?, 'user_button', 'active')`,
		).run(
			"legacy-memory-entry",
			LEGACY_UPGRADE.characterId,
			LEGACY_UPGRADE.memoryText,
			LEGACY_UPGRADE.memoryText,
			piSessionId,
			userEntryId,
			LEGACY_UPGRADE.conversationId,
		);
		db.prepare(
			`INSERT INTO memory_candidates
				(id, companion_id, kind, source_pi_session_id, source_native_entry_id,
				 source_conversation_id, source_kind, normalized_text, why, suggested_scope, status)
			 VALUES (?, ?, 'preference', ?, ?, ?, 'user_button', ?, ?, 'relationship', 'pending')`,
		).run(
			LEGACY_UPGRADE.memoryCandidateId,
			LEGACY_UPGRADE.characterId,
			piSessionId,
			userEntryId,
			LEGACY_UPGRADE.conversationId,
			LEGACY_UPGRADE.memoryText,
			"迁移认证记忆候选",
		);
		db.prepare(
			"INSERT INTO artifacts (id, logical_name, mime, bytes, sha256, status) VALUES (?, ?, 'text/plain', ?, ?, 'verified')",
		).run(
			"legacy-artifact",
			LEGACY_UPGRADE.attachmentName,
			Buffer.byteLength(LEGACY_UPGRADE.attachmentText),
			artifactSha256,
		);
		db.prepare(
			`INSERT INTO conversation_attachments
				(id, conversation_id, origin_entry_id, kind, name, total_bytes, file_count)
			 VALUES (?, ?, ?, 'file', ?, ?, 1)`,
		).run(
			LEGACY_UPGRADE.attachmentId,
			LEGACY_UPGRADE.conversationId,
			assistantEntryId,
			LEGACY_UPGRADE.attachmentName,
			Buffer.byteLength(LEGACY_UPGRADE.attachmentText),
		);
		db.prepare(
			`INSERT INTO conversation_attachment_files
				(id, attachment_id, entry_kind, relative_path, artifact_id, mime, material_kind,
				 bytes, sha256, extracted_text)
			 VALUES (?, ?, 'file', ?, 'legacy-artifact', 'text/plain', 'text', ?, ?, ?)`,
		).run(
			"legacy-attachment-file",
			LEGACY_UPGRADE.attachmentId,
			LEGACY_UPGRADE.attachmentName,
			Buffer.byteLength(LEGACY_UPGRADE.attachmentText),
			artifactSha256,
			LEGACY_UPGRADE.attachmentText,
		);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export async function createLegacyUpgradeFixture(
	appDataRoot: string,
	options: { ambiguousBothRoots?: boolean } = {},
): Promise<LegacyUpgradeFixture & { canonicalBeforeLaunch?: ByteSnapshot }> {
	const legacyRoot = join(appDataRoot, LEGACY_UPGRADE.legacyDirectoryName);
	const canonicalRoot = join(appDataRoot, LEGACY_UPGRADE.canonicalDirectoryName);
	mkdirSync(join(legacyRoot, "characters"), { recursive: true, mode: 0o700 });
	cpSync(characterSeed, join(legacyRoot, "characters", LEGACY_UPGRADE.characterId), {
		recursive: true,
		errorOnExist: true,
	});

	const sessionsRoot = join(legacyRoot, "sessions");
	const session = PiSessionStore.create({ sessionDir: sessionsRoot, cwd: sessionsRoot });
	const userEntryId = session.appendMessage({
		role: "user",
		content: LEGACY_UPGRADE.conversationUserText,
		timestamp: Date.parse("2026-01-02T03:04:05.000Z"),
	});
	const assistantEntryId = session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: LEGACY_UPGRADE.conversationAssistantText }],
		api: "openai-completions",
		provider: LEGACY_UPGRADE.providerId,
		model: LEGACY_UPGRADE.modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.parse("2026-01-02T03:04:06.000Z"),
	} as PiSessionMessage);

	const artifactSha256 = sha256(LEGACY_UPGRADE.attachmentText);
	mkdirSync(join(legacyRoot, "artifacts"), { recursive: true, mode: 0o700 });
	writeFileSync(join(legacyRoot, "artifacts", artifactSha256), LEGACY_UPGRADE.attachmentText);
	mkdirSync(join(legacyRoot, "companion-runtime"), { recursive: true, mode: 0o700 });
	writeFileSync(
		join(legacyRoot, "companion-runtime", "models.json"),
		`${JSON.stringify(
			{
				providers: {
					[LEGACY_UPGRADE.providerId]: {
						name: "Legacy Relay",
						baseUrl: "https://legacy-relay.example/v1",
						api: "openai-completions",
						authHeader: true,
						models: [{ id: LEGACY_UPGRADE.modelId, name: LEGACY_UPGRADE.modelLabel }],
					},
				},
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);

	const priorMigrations = MIGRATIONS.slice(0, -1);
	const database = new Database(join(legacyRoot, "storage"));
	try {
		database.migrate(priorMigrations);
		insertLegacyRows(
			database,
			legacyRoot,
			canonicalRoot,
			session.sessionFile,
			session.sessionId,
			userEntryId,
			assistantEntryId,
			artifactSha256,
		);
	} finally {
		database.close();
	}

	const audit = new AuditStore({
		dir: join(legacyRoot, "audit"),
		now: () => new Date("2026-01-02T03:04:07.000Z"),
		randomId: () => "00000000-0000-4000-8000-000000000001",
	});
	await audit.append("config", LEGACY_UPGRADE.auditAction, LEGACY_UPGRADE.auditDetail);

	const legacyBeforeLaunch = snapshotTreeBytes(legacyRoot);
	let canonicalBeforeLaunch: ByteSnapshot | undefined;
	if (options.ambiguousBothRoots) {
		cpSync(legacyRoot, canonicalRoot, { recursive: true, errorOnExist: true });
		canonicalBeforeLaunch = snapshotTreeBytes(canonicalRoot);
	}
	const sessionFileRelativePath = relative(legacyRoot, session.sessionFile).replaceAll("\\", "/");
	return {
		appDataRoot,
		legacyRoot,
		canonicalRoot,
		legacyBeforeLaunch,
		...(canonicalBeforeLaunch ? { canonicalBeforeLaunch } : {}),
		sessionFileRelativePath,
		artifactSha256,
		priorSchemaVersion: priorMigrations.at(-1)?.id ?? 0,
		targetSchemaVersion: MIGRATIONS.at(-1)?.id ?? 0,
	};
}

export function validateCanonicalCriticalFiles(fixture: LegacyUpgradeFixture): void {
	const databasePath = join(fixture.canonicalRoot, "storage", "canon.db");
	const database = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const integrity = database.prepare("PRAGMA integrity_check").all() as Array<
			Record<string, unknown>
		>;
		if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok") {
			throw new Error(`canonical database integrity failed: ${JSON.stringify(integrity)}`);
		}
		if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
			throw new Error("canonical database foreign keys failed");
		}
		const version = database.prepare("SELECT MAX(id) AS version FROM schema_migrations").get() as {
			version: number;
		};
		if (version.version !== fixture.targetSchemaVersion) {
			throw new Error(
				`canonical schema is ${version.version}, expected ${fixture.targetSchemaVersion}`,
			);
		}
		const memory = database
			.prepare("SELECT normalized_text FROM memory_candidates WHERE id = ?")
			.get(LEGACY_UPGRADE.memoryCandidateId) as { normalized_text?: string } | undefined;
		if (memory?.normalized_text !== LEGACY_UPGRADE.memoryText) {
			throw new Error("canonical memory candidate is missing");
		}
	} finally {
		database.close();
	}

	const session = readFileSync(
		join(fixture.canonicalRoot, fixture.sessionFileRelativePath),
		"utf8",
	);
	if (
		!session.includes(LEGACY_UPGRADE.conversationUserText) ||
		!session.includes(LEGACY_UPGRADE.conversationAssistantText)
	) {
		throw new Error("canonical Pi session is missing migrated messages");
	}
	const artifact = readFileSync(join(fixture.canonicalRoot, "artifacts", fixture.artifactSha256));
	if (sha256(artifact) !== fixture.artifactSha256) {
		throw new Error("canonical artifact hash mismatch");
	}
	const character = readFileSync(
		join(fixture.canonicalRoot, "characters", LEGACY_UPGRADE.characterId, "character.yaml"),
		"utf8",
	);
	if (!character.includes("id: jizhou") || !character.includes("name: 极昼")) {
		throw new Error("canonical character package is invalid");
	}
	const modelsText = readFileSync(
		join(fixture.canonicalRoot, "companion-runtime", "models.json"),
		"utf8",
	);
	const models = JSON.parse(modelsText) as { providers?: Record<string, unknown> };
	if (!Object.hasOwn(models.providers ?? {}, LEGACY_UPGRADE.providerId)) {
		throw new Error("canonical provider models config is missing");
	}
	if (
		/"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)"\s*:/i.test(modelsText)
	) {
		throw new Error("canonical provider models config contains a secret field");
	}
	const backupNames = readdirSync(join(fixture.canonicalRoot, "storage", "schema-backups"));
	if (
		!backupNames.some((name) =>
			name.endsWith(`-v${fixture.priorSchemaVersion}-to-v${fixture.targetSchemaVersion}.db`),
		)
	) {
		throw new Error("canonical pre-upgrade schema backup is missing");
	}
	if (!lstatSync(join(fixture.canonicalRoot, ".data-root-migration-complete.json")).isFile()) {
		throw new Error("canonical data-root migration marker is missing");
	}
}
