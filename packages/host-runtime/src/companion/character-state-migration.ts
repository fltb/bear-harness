import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import {
	recoverDurableFileTransactionSync,
	replaceDurableFileSync,
} from "../storage/durable-file-transaction.js";
import { companionStateDocuments } from "../storage/schema.js";
import type { CharacterPackage } from "./character-loader.js";
import { defaultSceneId } from "./character-loader.js";
import { digest, packageDigest, packageFiles } from "./character-package-files.js";
import { compileCharacterStateSchema } from "./state-schema.js";

type Row = typeof companionStateDocuments.$inferSelect;
type Change = {
	scope: string;
	conversationId?: string;
	field: string;
	before: string;
	after: string;
};
export function planCharacterMigration(db: AppDatabase, next: CharacterPackage) {
	const before = db
		.select()
		.from(companionStateDocuments)
		.where(eq(companionStateDocuments.companionId, next.id))
		.all();
	const compiled = compileCharacterStateSchema(next.state);
	const changes: Change[] = [];
	const after = before.map((row) => {
		const value: Record<string, unknown> = {};
		if (row.domain === "display") {
			value.sceneId =
				row.stateJson.sceneId === null ||
				next.scenes.some((item) => item.id === row.stateJson.sceneId)
					? row.stateJson.sceneId
					: defaultSceneId(next);
			value.expressionId =
				row.stateJson.expressionId === null ||
				next.visual.expressions.some((item) => item.id === row.stateJson.expressionId)
					? row.stateJson.expressionId
					: next.visual.default_expression;
		} else {
			for (const [key, scope] of compiled.partitions) {
				if (scope !== row.scope) continue;
				const old = row.stateJson[key];
				value[key] =
					old !== undefined &&
					compiled.validate({ ...structuredClone(compiled.defaults), [key]: old })
						? old
						: structuredClone(compiled.defaults[key]);
			}
		}
		for (const key of new Set([...Object.keys(row.stateJson), ...Object.keys(value)]))
			if (JSON.stringify(row.stateJson[key]) !== JSON.stringify(value[key]))
				changes.push({
					scope: row.scope,
					...(row.conversationId ? { conversationId: row.conversationId } : {}),
					field: `${row.domain}.${key}`,
					before: JSON.stringify(row.stateJson[key]) ?? "∅",
					after: JSON.stringify(value[key]) ?? "∅",
				});
		return JSON.stringify(row.stateJson) === JSON.stringify(value)
			? row
			: { ...row, stateJson: value, revision: row.revision + 1 };
	});
	const global = after.find((row) => row.domain === "character" && row.scope === "global");
	for (const row of after.filter((row) => row.domain === "character"))
		if (
			!compiled.validate({
				...structuredClone(compiled.defaults),
				...global?.stateJson,
				...row.stateJson,
			})
		)
			throw { kind: "conflict", reason: "character_state_migration_invalid" };
	return {
		before,
		after,
		review: {
			token: digest(
				Buffer.from(
					JSON.stringify({
						before,
						after,
						next: next.state,
						scenes: next.scenes,
						visual: next.visual,
					}),
				),
			),
			changes,
		},
	};
}
function writeRows(db: AppDatabase, rows: Row[]) {
	db.transaction((tx) => {
		for (const row of rows)
			tx.update(companionStateDocuments)
				.set({ stateJson: row.stateJson, revision: row.revision })
				.where(eq(companionStateDocuments.id, row.id))
				.run();
	});
}
type Journal = { characterId: string; nextHash: string; before: Row[]; after: Row[] };
export function recoverCharacterMigration(
	db: AppDatabase,
	root: string,
	packageRoot: string,
	characterId: string,
) {
	const path = join(root, "package-migration.json");
	const recovered = recoverDurableFileTransactionSync({
		root,
		target: path,
		verify: (source) => JSON.parse(readFileSync(source, "utf8")).characterId === characterId,
	});
	if (recovered.status === "recovery-required")
		throw new Error("Package migration recovery required");
	if (!existsSync(path)) return;
	if (lstatSync(path).isSymbolicLink()) throw new Error("Invalid package migration journal");
	const journal = JSON.parse(readFileSync(path, "utf8")) as Journal;
	if (
		journal.characterId !== characterId ||
		!/^[a-f0-9]{64}$/.test(journal.nextHash) ||
		!Array.isArray(journal.before) ||
		!Array.isArray(journal.after) ||
		[...journal.before, ...journal.after].some(
			(row) =>
				row.companionId !== characterId ||
				typeof row.id !== "string" ||
				!Number.isSafeInteger(row.revision) ||
				!row.stateJson ||
				typeof row.stateJson !== "object",
		)
	)
		throw new Error("Invalid package migration journal");
	const installed = packageDigest(packageFiles(packageRoot));
	writeRows(db, installed === journal.nextHash ? journal.after : journal.before);
	rmSync(path);
}
export function commitCharacterMigration<T>(
	db: AppDatabase,
	root: string,
	packageRoot: string,
	characterId: string,
	nextHash: string,
	plan: ReturnType<typeof planCharacterMigration>,
	publish: () => T,
): T {
	if (!plan.review.changes.length) return publish();
	const journal: Journal = { characterId, nextHash, before: plan.before, after: plan.after };
	const path = join(root, "package-migration.json");
	mkdirSync(join(root, "package-migrations"), { recursive: true, mode: 0o700 });
	const persist = (target: string) =>
		replaceDurableFileSync({
			root,
			target,
			stage: (stage) => writeFileSync(stage, JSON.stringify(journal), { mode: 0o600 }),
			verify: (stage) => JSON.parse(readFileSync(stage, "utf8")).nextHash === nextHash,
		});
	persist(join(root, "package-migrations", `${randomUUID()}.json`));
	persist(path);
	try {
		writeRows(db, plan.after);
		const result = publish();
		rmSync(path);
		return result;
	} catch (error) {
		recoverCharacterMigration(db, root, packageRoot, characterId);
		throw error;
	}
}
