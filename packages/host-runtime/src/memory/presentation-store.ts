import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { memoryPresentation } from "../storage/schema.js";

/** The Host-owned identity boundary for a provider memory record. */
export interface MemoryPresentationScope {
    readonly installationId: string;
    readonly userId: string;
    readonly companionId: string;
}

/** Labels assigned by the Host to explain how a direct memory was created. */
export type MemoryPresentationCreator =
    | "user_capture"
    | "assistant_tool"
    | "auto_episode"
    | "imported";

export interface DirectMemoryPresentationCreation {
    readonly backendMemoryId: string;
    readonly sourcePiEntryId?: string;
    readonly createdBy: MemoryPresentationCreator;
}

/**
 * Product metadata for a provider-owned memory.
 *
 * The provider remains the sole owner of the durable record. This projection
 * has only identity, provenance, and presentation state.
 */
export interface MemoryPresentationMetadata {
    readonly backendMemoryId: string;
    readonly scope: MemoryPresentationScope;
    readonly sourcePiEntryId?: string;
    readonly createdBy: MemoryPresentationCreator;
    readonly pinned: boolean;
    readonly replacementMemoryId?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

/**
 * Persists Host presentation metadata without mirroring provider memory data.
 * Every operation is explicitly scoped because backend IDs are only unique
 * inside a provider memory bank.
 */
export class MemoryPresentationStore {
    constructor(private readonly db: AppDatabase) {}

    recordDirectCreation(
        scope: MemoryPresentationScope,
        creation: DirectMemoryPresentationCreation,
    ): void {
        this.db
            .insert(memoryPresentation)
            .values({
                backendMemoryId: creation.backendMemoryId,
                installationId: scope.installationId,
                userId: scope.userId,
                companionId: scope.companionId,
                sourcePiEntryId: creation.sourcePiEntryId ?? null,
                createdBy: creation.createdBy,
            })
            .onConflictDoUpdate({
                target: [
                    memoryPresentation.backendMemoryId,
                    memoryPresentation.installationId,
                    memoryPresentation.userId,
                    memoryPresentation.companionId,
                ],
                set: {
                    sourcePiEntryId: creation.sourcePiEntryId ?? null,
                    createdBy: creation.createdBy,
                    updatedAt: sql`datetime('now')`,
                },
            })
            .run();
    }

    get(scope: MemoryPresentationScope, backendMemoryId: string): MemoryPresentationMetadata | undefined {
        const row = this.db
            .select()
            .from(memoryPresentation)
            .where(this.whereScope(scope, backendMemoryId))
            .get();
        return row ? toMetadata(row) : undefined;
    }

    setPinned(scope: MemoryPresentationScope, backendMemoryId: string, pinned: boolean): void {
        this.db
            .update(memoryPresentation)
            .set({ pinned, updatedAt: sql`datetime('now')` })
            .where(this.whereScope(scope, backendMemoryId))
            .run();
    }

    recordReplacement(
        scope: MemoryPresentationScope,
        backendMemoryId: string,
        replacementMemoryId?: string,
    ): void {
        this.db
            .update(memoryPresentation)
            .set({ replacementMemoryId: replacementMemoryId ?? null, updatedAt: sql`datetime('now')` })
            .where(this.whereScope(scope, backendMemoryId))
            .run();
    }

    forget(scope: MemoryPresentationScope, backendMemoryId: string): void {
        this.db.delete(memoryPresentation).where(this.whereScope(scope, backendMemoryId)).run();
    }

    list(
        scope: MemoryPresentationScope,
        backendMemoryIds: readonly string[],
    ): MemoryPresentationMetadata[] {
        if (backendMemoryIds.length === 0) return [];
        const rows = this.db
            .select()
            .from(memoryPresentation)
            .where(
                and(
                    eq(memoryPresentation.installationId, scope.installationId),
                    eq(memoryPresentation.userId, scope.userId),
                    eq(memoryPresentation.companionId, scope.companionId),
                    inArray(memoryPresentation.backendMemoryId, [...backendMemoryIds]),
                ),
            )
            .all()
            .map(toMetadata);
        const byId = new Map(rows.map((row) => [row.backendMemoryId, row]));
        return [...new Set(backendMemoryIds)].flatMap((id) => {
            const row = byId.get(id);
            return row ? [row] : [];
        });
    }

    private whereScope(scope: MemoryPresentationScope, backendMemoryId: string) {
        return and(
            eq(memoryPresentation.backendMemoryId, backendMemoryId),
            eq(memoryPresentation.installationId, scope.installationId),
            eq(memoryPresentation.userId, scope.userId),
            eq(memoryPresentation.companionId, scope.companionId),
        );
    }
}

function toMetadata(row: typeof memoryPresentation.$inferSelect): MemoryPresentationMetadata {
    return {
        backendMemoryId: row.backendMemoryId,
        scope: {
            installationId: row.installationId,
            userId: row.userId,
            companionId: row.companionId,
        },
        ...(row.sourcePiEntryId ? { sourcePiEntryId: row.sourcePiEntryId } : {}),
        createdBy: row.createdBy as MemoryPresentationCreator,
        pinned: row.pinned,
        ...(row.replacementMemoryId ? { replacementMemoryId: row.replacementMemoryId } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
