import { and, asc, eq, inArray, lt, ne } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { conversationAttachments, conversations, pendingTurns } from "../storage/schema.js";

export type PendingTurnState = "accepted" | "dispatched" | "user_persisted" | "completed";
export interface PendingTurnImage {
	readonly attachmentId: string;
	readonly mimeType: string;
	readonly data: Buffer;
}
export interface PendingTurnRecord {
	readonly id: string;
	readonly conversationId: string;
	readonly framedText: string;
	readonly images: readonly PendingTurnImage[];
	readonly attachmentIds: readonly string[];
	readonly attachmentSendNonce: string | null;
	readonly state: PendingTurnState;
	readonly piEntryId: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly completedAt: string | null;
	readonly lastError: string | null;
}
export interface CreateAcceptedPendingTurn {
	readonly id: string;
	readonly conversationId: string;
	readonly framedText: string;
	readonly images?: readonly PendingTurnImage[];
	readonly attachmentIds?: readonly string[];
	readonly attachmentSendNonce?: string | null;
}
export interface TransitionPendingTurn {
	readonly id: string;
	readonly conversationId: string;
	readonly to: Exclude<PendingTurnState, "accepted">;
	readonly piEntryId?: string;
}
export interface ListPendingTurns {
	readonly conversationId?: string;
	readonly includeCompleted?: boolean;
}

export const MAX_PENDING_TURN_TEXT_BYTES = 256 * 1024;
export const MAX_PENDING_TURN_IMAGES = 10;
export const MAX_PENDING_TURN_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PENDING_TURN_IMAGE_BYTES_TOTAL =
	MAX_PENDING_TURN_IMAGES * MAX_PENDING_TURN_IMAGE_BYTES;
export const MAX_PENDING_TURN_ATTACHMENTS = 10;
export const MAX_PENDING_TURN_ERROR_BYTES = 4 * 1024;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = new Set<PendingTurnState>(["accepted", "dispatched", "user_persisted", "completed"]);
const NEXT_STATE: Record<Exclude<PendingTurnState, "completed">, PendingTurnState> = {
	accepted: "dispatched",
	dispatched: "user_persisted",
	user_persisted: "completed",
};
type PendingTurnRow = typeof pendingTurns.$inferSelect;
type EncodedImage = { attachmentId: string; mimeType: string; data: string };
type StoreErrorKind = "validation_failed" | "not_found" | "conflict" | "data_corrupt";
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function fail(kind: StoreErrorKind, reason: string): never {
	throw { kind, reason };
}

/** Durable Host outbox for user turns accepted before Pi dispatch. */
export class PendingTurnStore {
	constructor(private readonly db: AppDatabase) {}

	createAccepted(input: CreateAcceptedPendingTurn): PendingTurnRecord {
		const value = prepareCreate(input);
		return this.db.transaction((tx) => {
			const existing = tx.select().from(pendingTurns).where(eq(pendingTurns.id, value.id)).get();
			if (existing) {
				if (!samePayload(existing, value)) fail("conflict", "pending_turn_idempotency_conflict");
				return decodeRow(existing);
			}
			const owner = tx
				.select({ id: conversations.id })
				.from(conversations)
				.where(eq(conversations.id, value.conversationId))
				.get();
			if (!owner) fail("not_found", "pending_turn_conversation_not_found");
			if (value.attachmentIds.length > 0) {
				const attachments = tx
					.select({
						id: conversationAttachments.id,
						originEntryId: conversationAttachments.originEntryId,
						sendNonce: conversationAttachments.sendNonce,
					})
					.from(conversationAttachments)
					.where(
						and(
							eq(conversationAttachments.conversationId, value.conversationId),
							inArray(conversationAttachments.id, value.attachmentIds),
						),
					)
					.all();
				if (
					attachments.length !== value.attachmentIds.length ||
					attachments.some(
						(item) => item.originEntryId !== null || item.sendNonce !== value.attachmentSendNonce,
					)
				)
					fail("conflict", "pending_turn_attachment_binding_invalid");
			}
			const now = new Date().toISOString();
			tx.insert(pendingTurns)
				.values({
					id: value.id,
					conversationId: value.conversationId,
					framedText: value.framedText,
					imagesJson: value.imagesJson,
					attachmentIdsJson: value.attachmentIdsJson,
					attachmentSendNonce: value.attachmentSendNonce,
					state: "accepted",
					createdAt: now,
					updatedAt: now,
				})
				.run();
			const created = tx.select().from(pendingTurns).where(eq(pendingTurns.id, value.id)).get();
			if (!created) fail("data_corrupt", "pending_turn_create_missing");
			return decodeRow(created);
		});
	}

	get(conversationId: string, id: string): PendingTurnRecord | undefined {
		validateOwnerKey(conversationId, id);
		const row = this.db
			.select()
			.from(pendingTurns)
			.where(and(eq(pendingTurns.id, id), eq(pendingTurns.conversationId, conversationId)))
			.get();
		return row ? decodeRow(row) : undefined;
	}

	lookupReplay(conversationId: string, id: string): PendingTurnRecord | undefined {
		return this.get(conversationId, id);
	}

	list(options: ListPendingTurns = {}): PendingTurnRecord[] {
		if (options.conversationId !== undefined)
			validateIdentifier(options.conversationId, "conversation_id");
		let rows: PendingTurnRow[];
		if (options.conversationId !== undefined && !options.includeCompleted) {
			rows = this.db
				.select()
				.from(pendingTurns)
				.where(
					and(
						eq(pendingTurns.conversationId, options.conversationId),
						ne(pendingTurns.state, "completed"),
					),
				)
				.orderBy(asc(pendingTurns.createdAt), asc(pendingTurns.id))
				.all();
		} else if (options.conversationId !== undefined) {
			rows = this.db
				.select()
				.from(pendingTurns)
				.where(eq(pendingTurns.conversationId, options.conversationId))
				.orderBy(asc(pendingTurns.createdAt), asc(pendingTurns.id))
				.all();
		} else if (!options.includeCompleted) {
			rows = this.db
				.select()
				.from(pendingTurns)
				.where(ne(pendingTurns.state, "completed"))
				.orderBy(asc(pendingTurns.createdAt), asc(pendingTurns.id))
				.all();
		} else {
			rows = this.db
				.select()
				.from(pendingTurns)
				.orderBy(asc(pendingTurns.createdAt), asc(pendingTurns.id))
				.all();
		}
		return rows.map(decodeRow);
	}

	listIncomplete(conversationId?: string): PendingTurnRecord[] {
		return this.list({ conversationId, includeCompleted: false });
	}

	transition(input: TransitionPendingTurn): PendingTurnRecord {
		validateOwnerKey(input.conversationId, input.id);
		if (input.to !== "dispatched" && input.to !== "user_persisted" && input.to !== "completed")
			fail("validation_failed", "pending_turn_transition_target_invalid");
		if (input.to === "user_persisted") validatePiEntryId(input.piEntryId);
		else if (input.piEntryId !== undefined)
			fail("validation_failed", "pending_turn_pi_entry_unexpected");
		return this.db.transaction((tx) => {
			const row = tx
				.select()
				.from(pendingTurns)
				.where(
					and(eq(pendingTurns.id, input.id), eq(pendingTurns.conversationId, input.conversationId)),
				)
				.get();
			if (!row) fail("not_found", "pending_turn_not_found");
			const current = decodeRow(row);
			if (current.state === input.to) {
				if (input.to === "user_persisted" && current.piEntryId !== input.piEntryId)
					fail("conflict", "pending_turn_pi_entry_conflict");
				return current;
			}
			if (current.state === "completed" || NEXT_STATE[current.state] !== input.to)
				fail("conflict", "pending_turn_transition_illegal");
			const now = new Date().toISOString();
			const changed = tx
				.update(pendingTurns)
				.set({
					state: input.to,
					piEntryId: input.to === "user_persisted" ? input.piEntryId : current.piEntryId,
					updatedAt: now,
					completedAt: input.to === "completed" ? now : null,
					lastError: null,
				})
				.where(
					and(
						eq(pendingTurns.id, input.id),
						eq(pendingTurns.conversationId, input.conversationId),
						eq(pendingTurns.state, current.state),
					),
				)
				.run();
			if (changed.changes !== 1) fail("conflict", "pending_turn_transition_race");
			const updated = tx.select().from(pendingTurns).where(eq(pendingTurns.id, input.id)).get();
			if (!updated) fail("data_corrupt", "pending_turn_transition_missing");
			return decodeRow(updated);
		});
	}

	recordError(conversationId: string, id: string, error: string): PendingTurnRecord {
		validateOwnerKey(conversationId, id);
		if (
			typeof error !== "string" ||
			error.length === 0 ||
			Buffer.byteLength(error) > MAX_PENDING_TURN_ERROR_BYTES
		)
			fail("validation_failed", "pending_turn_error_invalid");
		return this.db.transaction((tx) => {
			const row = tx
				.select()
				.from(pendingTurns)
				.where(and(eq(pendingTurns.id, id), eq(pendingTurns.conversationId, conversationId)))
				.get();
			if (!row) fail("not_found", "pending_turn_not_found");
			if (row.state === "completed") fail("conflict", "pending_turn_completed_immutable");
			const now = new Date().toISOString();
			tx.update(pendingTurns)
				.set({ lastError: error, updatedAt: now })
				.where(and(eq(pendingTurns.id, id), eq(pendingTurns.conversationId, conversationId)))
				.run();
			return decodeRow({ ...row, lastError: error, updatedAt: now });
		});
	}

	deleteCompleted(conversationId: string, id: string): boolean {
		validateOwnerKey(conversationId, id);
		return this.db.transaction((tx) => {
			const row = tx
				.select({ state: pendingTurns.state })
				.from(pendingTurns)
				.where(and(eq(pendingTurns.id, id), eq(pendingTurns.conversationId, conversationId)))
				.get();
			if (!row) return false;
			if (row.state !== "completed") fail("conflict", "pending_turn_incomplete_retained");
			return (
				tx
					.delete(pendingTurns)
					.where(
						and(
							eq(pendingTurns.id, id),
							eq(pendingTurns.conversationId, conversationId),
							eq(pendingTurns.state, "completed"),
						),
					)
					.run().changes === 1
			);
		});
	}

	pruneCompleted(beforeIso: string): number {
		validateIsoInstant(beforeIso);
		const count = this.db
			.delete(pendingTurns)
			.where(and(eq(pendingTurns.state, "completed"), lt(pendingTurns.completedAt, beforeIso)))
			.run().changes;
		return normalizeCount(count);
	}
}

function normalizeCount(count: number | bigint): number {
	if (typeof count === "bigint") {
		if (count < 0n || count > MAX_SAFE_INTEGER_BIGINT)
			throw new RangeError("pending turn count is outside the safe integer range");
		return Number(count);
	}
	if (!Number.isSafeInteger(count) || count < 0 || count > Number.MAX_SAFE_INTEGER)
		throw new RangeError("pending turn count is outside the safe integer range");
	return count;
}

interface PreparedCreate {
	readonly id: string;
	readonly conversationId: string;
	readonly framedText: string;
	readonly imagesJson: string;
	readonly attachmentIds: string[];
	readonly attachmentIdsJson: string;
	readonly attachmentSendNonce: string | null;
}

function prepareCreate(input: CreateAcceptedPendingTurn): PreparedCreate {
	if (!input || typeof input !== "object") fail("validation_failed", "pending_turn_input_invalid");
	validateOwnerKey(input.conversationId, input.id);
	if (
		typeof input.framedText !== "string" ||
		input.framedText.length === 0 ||
		Buffer.byteLength(input.framedText) > MAX_PENDING_TURN_TEXT_BYTES
	)
		fail("validation_failed", "pending_turn_text_invalid");
	const attachmentIds = [...(input.attachmentIds ?? [])];
	if (
		attachmentIds.length > MAX_PENDING_TURN_ATTACHMENTS ||
		new Set(attachmentIds).size !== attachmentIds.length
	)
		fail("validation_failed", "pending_turn_attachment_ids_invalid");
	for (const id of attachmentIds) validateIdentifier(id, "attachment_id");
	const nonce = input.attachmentSendNonce ?? null;
	if (attachmentIds.length === 0) {
		if (nonce !== null) fail("validation_failed", "pending_turn_attachment_nonce_unexpected");
	} else if (typeof nonce !== "string" || !UUID_V4.test(nonce)) {
		fail("validation_failed", "pending_turn_attachment_nonce_invalid");
	}
	const images = input.images ?? [];
	if (!Array.isArray(images) || images.length > MAX_PENDING_TURN_IMAGES)
		fail("validation_failed", "pending_turn_images_invalid");
	let totalBytes = 0;
	const encoded: EncodedImage[] = images.map((image) => {
		if (!image || typeof image !== "object" || !Buffer.isBuffer(image.data))
			fail("validation_failed", "pending_turn_image_invalid");
		validateIdentifier(image.attachmentId, "image_attachment_id");
		if (!attachmentIds.includes(image.attachmentId))
			fail("validation_failed", "pending_turn_image_attachment_unbound");
		if (
			typeof image.mimeType !== "string" ||
			!image.mimeType.startsWith("image/") ||
			image.mimeType.length > 255
		)
			fail("validation_failed", "pending_turn_image_mime_invalid");
		if (image.data.byteLength === 0 || image.data.byteLength > MAX_PENDING_TURN_IMAGE_BYTES)
			fail("validation_failed", "pending_turn_image_size_invalid");
		totalBytes += image.data.byteLength;
		return {
			attachmentId: image.attachmentId,
			mimeType: image.mimeType,
			data: image.data.toString("base64"),
		};
	});
	if (totalBytes > MAX_PENDING_TURN_IMAGE_BYTES_TOTAL)
		fail("validation_failed", "pending_turn_images_size_invalid");
	if (new Set(encoded.map((image) => image.attachmentId)).size !== encoded.length)
		fail("validation_failed", "pending_turn_image_attachment_duplicate");
	return {
		id: input.id,
		conversationId: input.conversationId,
		framedText: input.framedText,
		imagesJson: JSON.stringify(encoded),
		attachmentIds,
		attachmentIdsJson: JSON.stringify(attachmentIds),
		attachmentSendNonce: nonce,
	};
}

function samePayload(row: PendingTurnRow, value: PreparedCreate): boolean {
	return (
		row.conversationId === value.conversationId &&
		row.framedText === value.framedText &&
		row.imagesJson === value.imagesJson &&
		row.attachmentIdsJson === value.attachmentIdsJson &&
		row.attachmentSendNonce === value.attachmentSendNonce
	);
}

function decodeRow(row: PendingTurnRow): PendingTurnRecord {
	if (!UUID_V4.test(row.id) || !STATES.has(row.state))
		fail("data_corrupt", "pending_turn_row_invalid");
	if (
		(row.state === "completed") !== (row.completedAt !== null) ||
		["user_persisted", "completed"].includes(row.state) !== (row.piEntryId !== null)
	)
		fail("data_corrupt", "pending_turn_state_invalid");
	const attachmentIds = decodeAttachmentIds(row.attachmentIdsJson);
	const images = decodeImages(row.imagesJson, attachmentIds);
	if ((attachmentIds.length === 0) !== (row.attachmentSendNonce === null))
		fail("data_corrupt", "pending_turn_attachment_nonce_invalid");
	if (Buffer.byteLength(row.framedText) > MAX_PENDING_TURN_TEXT_BYTES)
		fail("data_corrupt", "pending_turn_text_invalid");
	if (row.lastError !== null && Buffer.byteLength(row.lastError) > MAX_PENDING_TURN_ERROR_BYTES)
		fail("data_corrupt", "pending_turn_error_invalid");
	return {
		id: row.id,
		conversationId: row.conversationId,
		framedText: row.framedText,
		images,
		attachmentIds,
		attachmentSendNonce: row.attachmentSendNonce,
		state: row.state,
		piEntryId: row.piEntryId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		completedAt: row.completedAt,
		lastError: row.lastError,
	};
}

function decodeAttachmentIds(json: string): string[] {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		fail("data_corrupt", "pending_turn_attachment_ids_malformed");
	}
	if (
		!Array.isArray(value) ||
		value.length > MAX_PENDING_TURN_ATTACHMENTS ||
		value.some((id) => typeof id !== "string" || id.length === 0 || id.length > 64) ||
		new Set(value).size !== value.length
	)
		fail("data_corrupt", "pending_turn_attachment_ids_malformed");
	return value;
}

function decodeImages(json: string, attachmentIds: readonly string[]): PendingTurnImage[] {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		fail("data_corrupt", "pending_turn_images_malformed");
	}
	if (!Array.isArray(value) || value.length > MAX_PENDING_TURN_IMAGES)
		fail("data_corrupt", "pending_turn_images_malformed");
	let total = 0;
	const seen = new Set<string>();
	return value.map((item) => {
		if (
			!isEncodedImage(item) ||
			!attachmentIds.includes(item.attachmentId) ||
			seen.has(item.attachmentId)
		)
			fail("data_corrupt", "pending_turn_images_malformed");
		seen.add(item.attachmentId);
		const data = Buffer.from(item.data, "base64");
		if (
			data.byteLength === 0 ||
			data.byteLength > MAX_PENDING_TURN_IMAGE_BYTES ||
			data.toString("base64") !== item.data
		)
			fail("data_corrupt", "pending_turn_images_malformed");
		total += data.byteLength;
		if (total > MAX_PENDING_TURN_IMAGE_BYTES_TOTAL)
			fail("data_corrupt", "pending_turn_images_malformed");
		return { attachmentId: item.attachmentId, mimeType: item.mimeType, data };
	});
}

function isEncodedImage(value: unknown): value is EncodedImage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const image = value as Record<string, unknown>;
	return (
		Object.keys(image).length === 3 &&
		typeof image.attachmentId === "string" &&
		image.attachmentId.length > 0 &&
		image.attachmentId.length <= 64 &&
		typeof image.mimeType === "string" &&
		image.mimeType.startsWith("image/") &&
		image.mimeType.length <= 255 &&
		typeof image.data === "string"
	);
}

function validateOwnerKey(conversationId: string, id: string): void {
	validateIdentifier(conversationId, "conversation_id");
	if (typeof id !== "string" || !UUID_V4.test(id))
		fail("validation_failed", "pending_turn_id_invalid");
}

function validateIdentifier(value: string, field: string): void {
	if (typeof value !== "string" || value.length === 0 || value.length > 64)
		fail("validation_failed", `pending_turn_${field}_invalid`);
}

function validatePiEntryId(value: string | undefined): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 256)
		fail("validation_failed", "pending_turn_pi_entry_invalid");
}

function validateIsoInstant(value: string): void {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
		!Number.isFinite(Date.parse(value))
	)
		fail("validation_failed", "pending_turn_prune_instant_invalid");
}
