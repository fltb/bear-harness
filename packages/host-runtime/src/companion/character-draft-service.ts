import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { characterDraftRevisions, characterDrafts } from "../storage/schema.js";
import type { CharacterLoader } from "./character-loader.js";

export type CharacterDraftStatus = "draft" | "validating" | "ready_to_publish" | "published";
export type CharacterDraftFiles = Record<string, { encoding: "utf8" | "base64"; content: string }>;

export class CharacterDraftService {
	constructor(
		private readonly db: AppDatabase,
		private readonly characterLoader: CharacterLoader,
	) {}

	create(input: { basePackageId?: string; locale?: string }) {
		const id = randomUUID();
		const locale = input.locale ?? "zh-CN";
		this.db.transaction((tx) => {
			tx.insert(characterDrafts)
				.values({ id, basePackageId: input.basePackageId, locale, currentRevision: 1 })
				.run();
			tx.insert(characterDraftRevisions).values({ draftId: id, revision: 1, filesJson: {} }).run();
		});
		return this.get(id);
	}

	get(id: string) {
		const draft = this.db.select().from(characterDrafts).where(eq(characterDrafts.id, id)).get();
		if (!draft) throw { kind: "not_found", reason: "character_draft_not_found" };
		const revision = this.db
			.select()
			.from(characterDraftRevisions)
			.where(
				and(
					eq(characterDraftRevisions.draftId, id),
					eq(characterDraftRevisions.revision, draft.currentRevision),
				),
			)
			.get();
		if (!revision) throw new Error(`character draft ${id} has no current revision`);
		return {
			id: draft.id,
			...(draft.basePackageId ? { basePackageId: draft.basePackageId } : {}),
			status: draft.status as CharacterDraftStatus,
			locale: draft.locale,
			currentRevision: draft.currentRevision,
			files: revision.filesJson,
		};
	}

	applyPatch(id: string, files: CharacterDraftFiles) {
		const current = this.get(id);
		const nextRevision = current.currentRevision + 1;
		const nextFiles = { ...current.files, ...files };
		this.db.transaction((tx) => {
			tx.insert(characterDraftRevisions)
				.values({ draftId: id, revision: nextRevision, filesJson: nextFiles })
				.run();
			tx.update(characterDrafts)
				.set({ currentRevision: nextRevision, updatedAt: new Date().toISOString() })
				.where(eq(characterDrafts.id, id))
				.run();
		});
		return this.get(id);
	}

	uploadAssets(
		id: string,
		expectedRevision: number,
		assets: Array<{ path: string; mime: string; base64: string }>,
	) {
		this.assertRevision(id, expectedRevision);
		for (const asset of assets) {
			if (!asset.mime.startsWith("image/"))
				throw { kind: "invalid_request", reason: "character_draft_asset_not_image" };
		}
		return this.applyPatch(
			id,
			Object.fromEntries(
				assets.map((asset) => [asset.path, { encoding: "base64" as const, content: asset.base64 }]),
			),
		);
	}

	validate(id: string, expectedRevision: number) {
		const draft = this.assertRevision(id, expectedRevision);
		this.validateFiles(draft.files);
		this.updateStatus(id, "ready_to_publish");
		return this.get(id);
	}

	publish(id: string, expectedRevision: number) {
		const draft = this.assertRevision(id, expectedRevision);
		this.validateFiles(draft.files);
		let character: ReturnType<CharacterLoader["install"]>;
		try {
			character = this.characterLoader.install(this.asInstallFiles(draft.files));
		} catch (error) {
			throw this.asRequestError(error);
		}
		this.updateStatus(id, "published");
		return { draft: this.get(id), character };
	}

	listRevisions(id: string) {
		return this.db
			.select({
				revision: characterDraftRevisions.revision,
				createdAt: characterDraftRevisions.createdAt,
			})
			.from(characterDraftRevisions)
			.where(eq(characterDraftRevisions.draftId, id))
			.orderBy(desc(characterDraftRevisions.revision))
			.all();
	}

	private assertRevision(id: string, expectedRevision: number) {
		const draft = this.get(id);
		if (draft.currentRevision !== expectedRevision)
			throw { kind: "conflict", reason: "character_draft_revision_mismatch" };
		return draft;
	}

	private asInstallFiles(files: CharacterDraftFiles) {
		return Object.entries(files).map(([path, file]) => ({
			path,
			base64:
				file.encoding === "base64"
					? file.content
					: Buffer.from(file.content, "utf8").toString("base64"),
		}));
	}

	private updateStatus(id: string, status: CharacterDraftStatus) {
		this.db
			.update(characterDrafts)
			.set({ status, updatedAt: new Date().toISOString() })
			.where(eq(characterDrafts.id, id))
			.run();
	}

	private validateFiles(files: CharacterDraftFiles) {
		try {
			this.characterLoader.validate(this.asInstallFiles(files));
		} catch (error) {
			throw this.asRequestError(error);
		}
	}

	private asRequestError(error: unknown) {
		if (error && typeof error === "object" && "kind" in error) return error;
		return {
			kind: "invalid_request",
			reason: error instanceof Error ? error.message : "character_package_invalid",
		};
	}
}
