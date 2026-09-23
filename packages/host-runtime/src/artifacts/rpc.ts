import type { ArtifactActionRequest, ArtifactSummary } from "@bear-harness/protocol";
import {
	ArtifactActionResponse,
	CacheKey,
	MAX_ARTIFACT_READ_BYTES,
	RPC,
} from "@bear-harness/protocol/schema";
import { and, eq } from "drizzle-orm";
import type { Dispatcher } from "../dispatcher.js";
import type { AppDatabase } from "../storage/database.js";
import type { InvalidationHub } from "../storage/invalidation-hub.js";
import { conversations, runs } from "../storage/schema.js";
import { ArtifactCorruptedError, type ArtifactRecord, type ArtifactStore } from "./index.js";
import { type ArtifactPresenter, createArtifactPresentationAccess } from "./presentation.js";

interface ArtifactRpcContext {
	readonly characterId: string;
	readonly signal: AbortSignal;
	readonly orm: AppDatabase;
	readonly artifacts: ArtifactStore;
	readonly invalidations: InvalidationHub;
	readonly artifactPresenter?: ArtifactPresenter;
}

/** Character-scoped handlers; all selection and presentation state stays in the window. */
export function registerArtifactHandlers(
	dispatcher: Dispatcher,
	context: ArtifactRpcContext,
): void {
	dispatcher.registerHandler(RPC.artifact.read, async (request) =>
		withOwnedArtifact(context, request, async (artifact) => {
			const { offset = 0, length = MAX_ARTIFACT_READ_BYTES } = request;
			const range = await context.artifacts.readBlobRange(
				artifact.id,
				offset,
				length,
				context.signal,
			);
			if (!range) throw { kind: "not_found", reason: "artifact_not_found" };
			const current = context.artifacts.get(artifact.id);
			if (!current) throw { kind: "not_found", reason: "artifact_not_found" };
			if (current.verification !== artifact.verification)
				context.invalidations.invalidate(CacheKey.runs());
			return {
				artifact: artifactWire(current),
				offset,
				nextOffset: range.nextOffset,
				eof: range.eof,
				base64: range.buffer.toString("base64"),
			};
		}),
	);
	dispatcher.registerHandler(RPC.artifact.open, (request) =>
		presentArtifact(context, "open", request),
	);
	dispatcher.registerHandler(RPC.artifact.reveal, (request) =>
		presentArtifact(context, "reveal", request),
	);
	dispatcher.registerHandler(RPC.artifact.saveAs, (request) =>
		presentArtifact(context, "saveAs", request),
	);
}

async function withOwnedArtifact<T>(
	context: ArtifactRpcContext,
	identity: ArtifactActionRequest,
	operation: (artifact: ArtifactRecord) => Promise<T>,
): Promise<T> {
	return context.artifacts.withRunAccess(identity.runId, async () => {
		context.signal.throwIfAborted();
		const conversation = context.orm
			.select({ id: conversations.id })
			.from(conversations)
			.where(
				and(
					eq(conversations.id, identity.conversationId),
					eq(conversations.companionId, context.characterId),
				),
			)
			.get();
		if (!conversation) throw { kind: "not_found", reason: "conversation_not_found" };
		const run = context.orm
			.select({ conversationId: runs.conversationId })
			.from(runs)
			.where(eq(runs.id, identity.runId))
			.get();
		if (!run || run.conversationId !== identity.conversationId)
			throw { kind: "not_found", reason: "run_not_found" };
		const artifact = context.artifacts.get(identity.artifactId);
		if (!artifact || artifact.producerRunId !== identity.runId)
			throw { kind: "not_found", reason: "artifact_not_found" };
		try {
			return await operation(artifact);
		} catch (error) {
			if (error instanceof ArtifactCorruptedError)
				context.invalidations.invalidate(CacheKey.runs());
			throw error;
		}
	});
}

async function presentArtifact(
	context: ArtifactRpcContext,
	action: "open" | "reveal" | "saveAs",
	identity: ArtifactActionRequest,
) {
	return withOwnedArtifact(context, identity, async (artifact) => {
		if (!(await context.artifacts.readBlobRange(artifact.id, 0, 1, context.signal)))
			throw { kind: "not_found", reason: "artifact_not_found" };
		const current = context.artifacts.get(artifact.id);
		if (!current) throw { kind: "not_found", reason: "artifact_not_found" };
		if (current.verification !== artifact.verification)
			context.invalidations.invalidate(CacheKey.runs());
		const presenter = context.artifactPresenter;
		const present = presenter?.[action];
		if (!presenter || !present) return { outcome: "unsupported" as const };
		const scoped = createArtifactPresentationAccess(context.artifacts, current);
		let result: Awaited<ReturnType<NonNullable<typeof present>>>;
		try {
			result = await present.call(presenter, {
				artifact: Object.freeze({ ...current }),
				access: scoped.access,
			});
		} finally {
			await scoped.close();
		}
		const response = ArtifactActionResponse.parse(result);
		if (action === "saveAs" && response.outcome === "completed") {
			context.artifacts.markSaved(artifact.id);
			context.invalidations.invalidate(CacheKey.runs());
		}
		return response;
	});
}

function artifactWire(artifact: ArtifactRecord): ArtifactSummary {
	return {
		id: artifact.id,
		name: artifact.logicalName,
		mime: artifact.mime,
		bytes: artifact.bytes,
		sha256: artifact.sha256,
		verification: artifact.verification,
		saved: artifact.saved,
		adopted: artifact.adopted,
		createdAt: artifact.createdAt,
	};
}
