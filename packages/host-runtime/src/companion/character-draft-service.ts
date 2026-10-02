import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CharacterDraftTransferRequest } from "@bear-harness/protocol";
import {
	CharacterDraft as DraftSchema,
	CharacterDraftTransferRequest as TransferSchema,
} from "@bear-harness/protocol/schema";
import { z } from "@bear-harness/schema";
import { zipSync } from "fflate";
import { parseDocument, stringify } from "yaml";
import { syncFileForDurability } from "../storage/durable-file-sync.js";
import {
	recoverDurableFileTransactionSync,
	replaceDurableFileSync,
} from "../storage/durable-file-transaction.js";
import type { RuntimeLayout } from "../storage/layout.js";
import { moveDraftFiles } from "./character-draft-files.js";
import type { CharacterLoader } from "./character-loader.js";
import { CharacterManifestSchema } from "./character-loader.js";
import {
	DRAFT_READ_CHUNK_BYTES,
	DRAFT_WRITE_MAX_BYTES,
	digest,
	PACKAGE_MAX_BYTES,
	packageDigest,
	packageFilePath,
	packageFiles,
	textFile,
} from "./character-package-files.js";
import { RoleSkillMetadata } from "./role-resources.js";

type Draft = z.infer<typeof DraftSchema>;
export type CharacterDraftFiles = Record<
	string,
	{ encoding: "utf8" | "base64"; content: string } | null
>;
type StoredDraft = Draft & { schemaVersion: 1 };
function error(reason: string, kind = "invalid_request"): never {
	throw { kind, reason };
}

/** Author files belong to their character, never the installation settings database. */
export class CharacterDraftService {
	private readonly verified = new Map<string, string>();
	constructor(
		private readonly layout: RuntimeLayout,
		private readonly characterLoader: CharacterLoader,
	) {
		// Trial handles are process-local; a restart cannot resume them as production Sessions.
		for (const owner of readdirSync(layout.companionsRoot, { withFileTypes: true })) {
			if (!owner.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(owner.name)) continue;
			const root = join(layout.companion(owner.name).root, "drafts");
			if (!existsSync(root) || lstatSync(root).isSymbolicLink()) continue;
			for (const draft of readdirSync(root, { withFileTypes: true })) {
				if (!draft.isDirectory() || !draft.name.startsWith(`${owner.name}~`)) continue;
				const trial = join(this.directory(draft.name), "trials");
				if (existsSync(trial)) {
					if (lstatSync(trial).isSymbolicLink()) error("character_draft_path_invalid");
					rmSync(trial, { recursive: true });
				}
			}
		}
	}

	create(input: { characterId: string; basePackageId?: string; name?: string; locale?: string }) {
		const owner = this.owner(input.characterId);
		const source = input.basePackageId ?? (this.characterLoader.load(owner) ? owner : undefined);
		if ((input.name || (source && source !== owner)) && this.characterLoader.load(owner))
			error("character_package_already_exists", "conflict");
		const bytes = source
			? packageFiles(this.characterLoader.packageLocation(source))
			: {
					"character.yaml": Buffer.from(
						stringify({
							format_version: 2,
							version: "1.0.0",
							id: owner,
							name: input.name || owner,
							language: input.locale ?? "zh-CN",
							behavior: { identity: { summary: "" } },
						}),
					),
				};
		const baseline = source === owner ? packageDigest(bytes) : undefined;
		if (source !== owner) {
			const document = parseDocument(bytes["character.yaml"]?.toString("utf8") ?? "");
			document.set("id", owner);
			if (input.name) document.set("name", input.name);
			bytes["character.yaml"] = Buffer.from(String(document));
		}
		const id = `${owner}~${randomUUID()}`;
		const directory = this.directory(id, true);
		const files = Object.fromEntries(
			Object.entries(bytes).map(([path, bytes]) => [path, this.storeFile(directory, path, bytes)]),
		);
		const draft: Draft = {
			id,
			characterId: owner,
			...(baseline ? { basePackageId: owner, baseSha256: baseline } : {}),
			status: "draft",
			locale: input.locale ?? "zh-CN",
			currentRevision: 1,
			updatedAt: new Date().toISOString(),
			files,
		};
		this.write(directory, "revision-1.json", { schemaVersion: 1, ...draft });
		this.write(directory, "current.json", { schemaVersion: 1, ...draft });
		return draft;
	}

	get(id: string): Draft {
		return this.read(id, "current.json");
	}
	list(input: { cursor?: string; characterId?: string; limit?: number } = {}) {
		const result: Array<Omit<Draft, "files">> = [];
		for (const owner of readdirSync(this.layout.companionsRoot, { withFileTypes: true })) {
			if (
				!owner.isDirectory() ||
				!/^[a-z0-9][a-z0-9-]{0,63}$/.test(owner.name) ||
				(input.characterId && input.characterId !== owner.name)
			)
				continue;
			const root = join(this.layout.companion(owner.name).root, "drafts");
			if (!existsSync(root) || lstatSync(root).isSymbolicLink()) continue;
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory() || !entry.name.startsWith(`${owner.name}~`)) continue;
				const { files: _, ...draft } = this.get(entry.name);
				if (
					draft.status !== "published" &&
					(!input.cursor || `${draft.updatedAt}/${draft.id}` < input.cursor)
				)
					result.push(draft);
			}
		}
		result.sort((a, b) => `${b.updatedAt}/${b.id}`.localeCompare(`${a.updatedAt}/${a.id}`));
		const page = result.slice(0, input.limit ?? 50);
		const last = page.at(-1);
		return {
			drafts: page,
			...(last && result.length > page.length
				? { nextCursor: `${last.updatedAt}/${last.id}` }
				: {}),
		};
	}
	schemas() {
		return {
			manifest: z.toJSONSchema(CharacterManifestSchema, { io: "input" }),
			skill: z.toJSONSchema(RoleSkillMetadata, { io: "input" }),
		};
	}
	delete(id: string, revision: number) {
		this.assertRevision(id, revision);
		rmSync(this.directory(id), { recursive: true });
	}
	prune(id: string, revision: number, keep: number) {
		const current = this.assertRevision(id, revision);
		const root = this.directory(id);
		for (const name of readdirSync(root))
			if (/^upload-[0-9a-f-]+\.(?:json|bin)$/.test(name)) rmSync(join(root, name));
		const retained = new Set([
			"current.json",
			...this.revisions(id)
				.slice(0, keep)
				.map((n) => `revision-${n}.json`),
		]);
		const hashes = new Set(Object.values(current.files).map((file) => file.sha256));
		for (const name of retained)
			for (const file of Object.values(this.read(id, name).files)) hashes.add(file.sha256);
		for (const name of readdirSync(root)) {
			if (
				(/^revision-\d+\.json$/.test(name) && !retained.has(name)) ||
				(/^[0-9a-f]{64}$/.test(name) && !hashes.has(name)) ||
				/^export-\d+\.zip$/.test(name)
			)
				rmSync(join(root, name));
		}
		return current;
	}
	move(id: string, revision: number, from: string, to: string) {
		const draft = this.assertRevision(id, revision);
		packageFilePath(from);
		packageFilePath(to);
		const root = this.directory(id);
		const moved = moveDraftFiles(this.buffers(draft), from, to);
		for (const path of Object.keys(moved)) packageFilePath(path);
		return this.revise(
			draft,
			Object.fromEntries(
				Object.entries(moved).map(([path, bytes]) => [path, this.storeFile(root, path, bytes)]),
			),
		);
	}
	review(id: string, revision: number) {
		const draft = this.assertRevision(id, revision);
		const files = this.buffers(draft);
		const before = this.characterLoader.load(draft.characterId)
			? packageFiles(this.characterLoader.packageLocation(draft.characterId))
			: {};
		const changes = [...new Set([...Object.keys(before), ...Object.keys(files)])]
			.sort()
			.flatMap((path) => {
				if (before[path] && files[path] && digest(before[path]) === digest(files[path])) return [];
				return [
					{
						path,
						kind: !before[path]
							? ("added" as const)
							: !files[path]
								? ("deleted" as const)
								: ("modified" as const),
						binary: !textFile(path, files[path] ?? (before[path] as Buffer)),
					},
				];
			});
		const issues: Array<{ file: string; path: string; message: string }> = [];
		for (const [file, bytes] of Object.entries(files)) {
			if (file !== "character.yaml" && !file.endsWith("/SKILL.md")) continue;
			const source = bytes.toString("utf8");
			const yaml =
				file === "character.yaml" ? source : source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
			if (yaml === undefined) {
				issues.push({ file, path: "", message: "Missing YAML frontmatter" });
				continue;
			}
			const doc = parseDocument(yaml);
			if (doc.errors.length) {
				for (const problem of doc.errors) issues.push({ file, path: "", message: problem.message });
				continue;
			}
			const parsed = (
				file === "character.yaml" ? CharacterManifestSchema : RoleSkillMetadata
			).safeParse(doc.toJS());
			if (!parsed.success)
				for (const problem of parsed.error.issues)
					issues.push({ file, path: problem.path.join("."), message: problem.message });
		}
		if (!files["character.yaml"])
			issues.push({ file: "character.yaml", path: "", message: "Missing character.yaml" });
		if (!issues.length)
			try {
				this.validatePackage(draft);
			} catch (cause) {
				const message =
					cause && typeof cause === "object" && "reason" in cause
						? String(cause.reason)
						: String(cause);
				issues.push({
					file: Object.keys(files).find((path) => message.includes(path)) ?? "character.yaml",
					path: "",
					message,
				});
			}
		return { changes, issues };
	}
	diff(id: string, revision: number, path: string) {
		const draft = this.assertRevision(id, revision);
		packageFilePath(path);
		const before = this.characterLoader.load(draft.characterId)
			? packageFiles(this.characterLoader.packageLocation(draft.characterId))[path]
			: undefined;
		const after = draft.files[path] ? this.blob(id, draft.files[path].sha256) : undefined;
		const limit = 256 * 1024;
		return {
			before: before && textFile(path, before) ? before.subarray(0, limit).toString("utf8") : "",
			after: after && textFile(path, after) ? after.subarray(0, limit).toString("utf8") : "",
			truncated: (before?.length ?? 0) > limit || (after?.length ?? 0) > limit,
		};
	}
	export(id: string, revision: number, offset: number) {
		const draft = this.assertRevision(id, revision);
		const path = join(this.directory(id), `export-${revision}.zip`);
		if (!existsSync(path)) {
			writeFileSync(path, zipSync(this.buffers(draft), { level: 0 }), { flag: "wx", mode: 0o600 });
		}
		return this.chunk(path, offset);
	}
	transfer(input: CharacterDraftTransferRequest) {
		const root = this.directory(input.id);
		if (input.action === "begin") {
			const draft = this.assertRevision(input.id, input.expectedRevision);
			if (
				Object.values(draft.files).reduce((n, f) => n + f.size, 0) -
					(draft.files[input.path]?.size ?? 0) +
					input.size >
				PACKAGE_MAX_BYTES
			)
				error("character_package_size_limit");
			if (readdirSync(root).filter((name) => /^upload-.*\.json$/.test(name)).length >= 4)
				error("character_draft_upload_limit");
			packageFilePath(input.path);
			const uploadId = randomUUID();
			writeFileSync(join(root, `upload-${uploadId}.json`), JSON.stringify(input), {
				flag: "wx",
				mode: 0o600,
			});
			writeFileSync(join(root, `upload-${uploadId}.bin`), "", { flag: "wx", mode: 0o600 });
			return { uploadId, offset: 0 };
		}
		const prefix = join(root, `upload-${input.uploadId}`);
		if (input.action === "cancel") {
			rmSync(`${prefix}.json`, { force: true });
			rmSync(`${prefix}.bin`, { force: true });
			return {};
		}
		if (lstatSync(`${prefix}.json`).isSymbolicLink() || lstatSync(`${prefix}.bin`).isSymbolicLink())
			error("character_draft_path_invalid");
		const metadata = TransferSchema.parse(JSON.parse(readFileSync(`${prefix}.json`, "utf8")));
		if (metadata.action !== "begin" || metadata.id !== input.id)
			error("character_draft_upload_invalid");
		packageFilePath(metadata.path);
		const draft = this.assertRevision(input.id, metadata.expectedRevision);
		const size = lstatSync(`${prefix}.bin`).size;
		if (input.action === "append") {
			const bytes = Buffer.from(input.base64, "base64");
			if (
				size !== input.offset ||
				size + bytes.length > metadata.size ||
				bytes.toString("base64") !== input.base64
			)
				error("character_draft_upload_offset");
			appendFileSync(`${prefix}.bin`, bytes);
			return { offset: size + bytes.length };
		}
		if (input.expectedRevision !== metadata.expectedRevision || size !== metadata.size)
			error("character_draft_upload_incomplete");
		const bytes = readFileSync(`${prefix}.bin`);
		const files = { ...draft.files, [metadata.path]: this.storeFile(root, metadata.path, bytes) };
		if (
			Object.keys(files).length > 2048 ||
			Object.values(files).reduce((n, f) => n + f.size, 0) > PACKAGE_MAX_BYTES
		)
			error("character_package_size_limit");
		const next = this.revise(draft, files);
		rmSync(`${prefix}.json`);
		rmSync(`${prefix}.bin`);
		return { draft: next };
	}
	private buffers(draft: Draft) {
		return Object.fromEntries(
			Object.entries(draft.files).map(([path, file]) => [path, this.blob(draft.id, file.sha256)]),
		);
	}
	private chunk(path: string, offset: number, expected?: string) {
		if (lstatSync(path).isSymbolicLink()) error("character_draft_path_invalid");
		const fd = openSync(path, "r");
		try {
			const stat = fstatSync(fd, { bigint: true });
			const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
			let sha256 = this.verified.get(key);
			if (!sha256) {
				sha256 = digest(readFileSync(fd));
				this.verified.set(key, sha256);
				if (this.verified.size > 64)
					this.verified.delete(this.verified.keys().next().value as string);
			}
			if (expected && expected !== sha256) error("character_draft_file_corrupt");
			const bytes = Buffer.alloc(
				Math.min(DRAFT_READ_CHUNK_BYTES, Math.max(0, Number(stat.size) - offset)),
			);
			const count = readSync(fd, bytes, 0, bytes.length, offset);
			const after = fstatSync(fd, { bigint: true });
			if (
				count !== bytes.length ||
				stat.size !== after.size ||
				stat.mtimeNs !== after.mtimeNs ||
				stat.ctimeNs !== after.ctimeNs
			)
				error("character_draft_file_changed", "conflict");
			return { base64: bytes.toString("base64"), totalBytes: Number(stat.size), sha256 };
		} finally {
			closeSync(fd);
		}
	}

	readFile(id: string, path: string, offset = 0, expectedSha256?: string) {
		const draft = this.get(id);
		const file = draft.files[packageFilePath(path)];
		if (!file) error("character_draft_file_not_found", "not_found");
		if (expectedSha256 && file.sha256 !== expectedSha256)
			error("character_draft_revision_mismatch", "conflict");
		return this.chunk(join(this.directory(id), file.sha256), offset, file.sha256);
	}

	applyPatch(id: string, expectedRevision: number, changes: CharacterDraftFiles) {
		const current = this.assertRevision(id, expectedRevision);
		const files = { ...current.files };
		const directory = this.directory(id);
		for (const [path, file] of Object.entries(changes)) {
			packageFilePath(path);
			if (file === null) {
				delete files[path];
				continue;
			}
			const bytes = Buffer.from(file.content, file.encoding === "utf8" ? "utf8" : "base64");
			if (bytes.length > DRAFT_WRITE_MAX_BYTES) error("character_draft_file_size_limit");
			if (file.encoding === "base64" && bytes.toString("base64") !== file.content)
				error("character_draft_base64_invalid");
			files[path] = this.storeFile(directory, path, bytes);
		}
		if (
			Object.keys(files).length > 2048 ||
			Object.values(files).reduce((sum, file) => sum + file.size, 0) > PACKAGE_MAX_BYTES
		)
			error("character_package_size_limit");
		return this.revise(current, files);
	}

	uploadAssets(
		id: string,
		expectedRevision: number,
		assets: Array<{ path: string; mime: string; base64: string }>,
	) {
		return this.applyPatch(
			id,
			expectedRevision,
			Object.fromEntries(
				assets.map((asset) => [asset.path, { encoding: "base64", content: asset.base64 }]),
			),
		);
	}
	restoreRevision(id: string, expectedRevision: number, sourceRevision: number) {
		const current = this.assertRevision(id, expectedRevision);
		const source = this.read(id, `revision-${sourceRevision}.json`);
		return this.revise(current, source.files);
	}
	private revisions(id: string) {
		return readdirSync(this.directory(id))
			.flatMap((name) =>
				/^revision-(\d+)\.json$/.test(name) ? [Number(name.match(/\d+/)?.[0])] : [],
			)
			.sort((a, b) => b - a);
	}
	listRevisions(id: string, before?: number) {
		return this.revisions(id)
			.filter((n) => !before || n < before)
			.slice(0, 100)
			.map((revision) => ({
				revision,
				createdAt: this.read(id, `revision-${revision}.json`).updatedAt,
			}));
	}

	validate(id: string, expectedRevision: number) {
		const draft = this.assertRevision(id, expectedRevision);
		this.validatePackage(draft);
		const validated = { ...draft, status: "ready_to_publish" as const };
		this.write(this.directory(id), "current.json", { schemaVersion: 1, ...validated });
		return validated;
	}
	publish(id: string, expectedRevision: number, stateMigrationValidated = false) {
		const draft = this.assertRevision(id, expectedRevision);
		if (draft.status === "published") {
			const character = this.characterLoader.load(draft.characterId);
			if (!character) error("character_package_not_found", "not_found");
			return { draft, character };
		}
		this.validatePackage(draft);
		const files = this.installFiles(draft);
		const installed = this.characterLoader.load(draft.characterId);
		const alreadyCommitted =
			installed &&
			packageDigest(packageFiles(this.characterLoader.packageLocation(draft.characterId))) ===
				packageDigest(
					Object.fromEntries(files.map((file) => [file.path, Buffer.from(file.base64, "base64")])),
				);
		const character = alreadyCommitted
			? installed
			: draft.baseSha256
				? this.characterLoader.replacePackage(
						draft.characterId,
						draft.baseSha256,
						files,
						stateMigrationValidated,
					)
				: this.characterLoader.install(files);
		const next = {
			...draft,
			status: "published" as const,
			basePackageId: character.id,
			baseSha256: packageDigest(packageFiles(this.characterLoader.packageLocation(character.id))),
		};
		this.write(this.directory(id), "current.json", { schemaVersion: 1, ...next });
		return { draft: next, character };
	}
	private validatePackage(draft: Draft) {
		try {
			const character = this.characterLoader.validate(this.installFiles(draft));
			if (character.id !== draft.characterId) error("character_id_immutable");
		} catch (cause) {
			if (cause && typeof cause === "object" && "kind" in cause) throw cause;
			error(cause instanceof Error ? cause.message : "character_package_invalid");
		}
	}
	trialSource(id: string, revision: number) {
		const draft = this.validate(id, revision);
		return { draft, root: this.directory(id), files: this.installFiles(draft) };
	}
	private installFiles(draft: Draft) {
		return Object.entries(draft.files).map(([path, file]) => ({
			path,
			base64: this.blob(draft.id, file.sha256).toString("base64"),
		}));
	}
	private revise(draft: Draft, files: Draft["files"]) {
		const next = {
			...draft,
			files,
			status: "draft" as const,
			currentRevision: draft.currentRevision + 1,
			updatedAt: new Date().toISOString(),
		};
		this.write(this.directory(draft.id), `revision-${next.currentRevision}.json`, {
			schemaVersion: 1,
			...next,
		});
		this.write(this.directory(draft.id), "current.json", { schemaVersion: 1, ...next });
		return next;
	}
	private assertRevision(id: string, expected: number) {
		const draft = this.get(id);
		if (draft.currentRevision !== expected) error("character_draft_revision_mismatch", "conflict");
		return draft;
	}
	private owner(id: string) {
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) error("character_id_invalid");
		return id;
	}
	private directory(id: string, create = false) {
		const [owner, uuid, extra] = id.split("~");
		if (!owner || !uuid || extra || !/^[0-9a-f-]{36}$/.test(uuid))
			error("character_draft_not_found", "not_found");
		this.owner(owner);
		const root = create
			? this.layout.ensureCompanionDirectories(owner).root
			: this.layout.companion(owner).root;
		let path = root;
		for (const part of ["", "drafts", id]) {
			if (part) path = join(path, part);
			if (create && !existsSync(path)) mkdirSync(path, { mode: 0o700 });
			if (!existsSync(path)) error("character_draft_not_found", "not_found");
			const stat = lstatSync(path);
			if (stat.isSymbolicLink() || !stat.isDirectory()) error("character_draft_path_invalid");
		}
		return path;
	}
	private read(id: string, name: string): Draft {
		const root = this.directory(id);
		const path = join(root, name);
		const recovery = recoverDurableFileTransactionSync({
			root,
			target: path,
			verify: (candidate) => {
				const value = JSON.parse(readFileSync(candidate, "utf8"));
				return value.schemaVersion === 1 && value.id === id;
			},
		});
		if (recovery.status === "recovery-required")
			error("character_draft_recovery_required", "conflict");
		if (!existsSync(path)) error("character_draft_not_found", "not_found");
		if (lstatSync(path).isSymbolicLink()) error("character_draft_path_invalid");
		const stored = JSON.parse(readFileSync(path, "utf8"));
		if (stored.schemaVersion !== 1) error("character_draft_version_invalid");
		const { schemaVersion: _, ...wire } = stored;
		const draft = DraftSchema.parse(wire);
		if (draft.id !== id || draft.characterId !== id.split("~")[0])
			error("character_draft_owner_invalid");
		return draft;
	}
	private storeFile(root: string, path: string, bytes: Buffer) {
		const sha256 = digest(bytes);
		const target = join(root, sha256);
		if (!existsSync(target)) {
			writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
			syncFileForDurability(target);
		} else if (lstatSync(target).isSymbolicLink() || digest(readFileSync(target)) !== sha256)
			error("character_draft_file_corrupt");
		return {
			sha256,
			size: bytes.length,
			encoding: textFile(path, bytes) ? ("utf8" as const) : ("base64" as const),
		};
	}
	private blob(id: string, sha256: string) {
		if (!/^[0-9a-f]{64}$/.test(sha256)) error("character_draft_file_corrupt");
		const path = join(this.directory(id), sha256);
		if (lstatSync(path).isSymbolicLink()) error("character_draft_path_invalid");
		const bytes = readFileSync(path);
		if (digest(bytes) !== sha256) error("character_draft_file_corrupt");
		return bytes;
	}
	private write(root: string, name: string, value: StoredDraft) {
		replaceDurableFileSync({
			root,
			target: join(root, name),
			stage: (temporary) => writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }),
			verify: (candidate) => {
				const parsed = JSON.parse(readFileSync(candidate, "utf8"));
				if (parsed.schemaVersion !== 1) throw new Error("Draft version missing");
				return true;
			},
		});
	}
}
