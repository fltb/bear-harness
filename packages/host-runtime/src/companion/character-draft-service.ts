import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CharacterDraft as DraftSchema } from "@bear-harness/protocol/schema";
import type { z } from "@bear-harness/schema";
import { parseDocument, stringify } from "yaml";
import { syncFileForDurability } from "../storage/durable-file-sync.js";
import {
	recoverDurableFileTransactionSync,
	replaceDurableFileSync,
} from "../storage/durable-file-transaction.js";
import type { RuntimeLayout } from "../storage/layout.js";
import type { CharacterLoader } from "./character-loader.js";
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
	constructor(
		private readonly layout: RuntimeLayout,
		private readonly characterLoader: CharacterLoader,
	) {}

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
	list() {
		const result: Array<Omit<Draft, "files">> = [];
		for (const owner of readdirSync(this.layout.companionsRoot, { withFileTypes: true })) {
			if (!owner.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(owner.name)) continue;
			const root = join(this.layout.companion(owner.name).root, "drafts");
			if (!existsSync(root) || lstatSync(root).isSymbolicLink()) continue;
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory() || !entry.name.startsWith(`${owner.name}~`)) continue;
				const { files: _, ...draft } = this.get(entry.name);
				if (draft.status !== "published") result.push(draft);
				if (result.length > 200) error("character_draft_list_limit");
			}
		}
		return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	readFile(id: string, path: string, offset = 0) {
		const draft = this.get(id);
		const file = draft.files[packageFilePath(path)];
		if (!file) error("character_draft_file_not_found", "not_found");
		const bytes = this.blob(id, file.sha256);
		return {
			base64: bytes.subarray(offset, offset + DRAFT_READ_CHUNK_BYTES).toString("base64"),
			totalBytes: bytes.length,
			sha256: file.sha256,
		};
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
	listRevisions(id: string) {
		const current = this.get(id);
		return Array.from({ length: Math.min(current.currentRevision, 100) }, (_, index) => {
			const revision = current.currentRevision - index;
			const draft = this.read(id, `revision-${revision}.json`);
			return { revision, createdAt: draft.updatedAt };
		});
	}
	validate(id: string, expectedRevision: number) {
		const draft = this.assertRevision(id, expectedRevision);
		this.validatePackage(draft);
		const validated = { ...draft, status: "ready_to_publish" as const };
		this.write(this.directory(id), "current.json", { schemaVersion: 1, ...validated });
		return validated;
	}
	publish(id: string, expectedRevision: number) {
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
				? this.characterLoader.replacePackage(draft.characterId, draft.baseSha256, files)
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
