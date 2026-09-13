import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { IMemoryStore, ProfileRecord, ProfileSyncRecord } from "../store/types.js";
import { readSceneIndex, syncSceneIndex } from "../scene/scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";

const PROFILE_SCOPE = "global";

/** Check if an error is a rename race condition (another concurrent pull won). */
function isRenameRaceError(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException)?.code;
	return code === "ENOTEMPTY" || code === "EEXIST";
}

interface Logger {
	debug?: (message: string) => void;
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
}

export interface ProfileBaseline {
	version: number;
	contentMd5: string;
	createdAtMs: number;
}

export function buildProfileStableId(scope: string, type: "l2" | "l3", filename: string): string {
	const hash = createHash("sha256").update(`${scope}\u0000${type}\u0000${filename}`).digest("hex");
	return `profile:${hash}`;
}

function md5(text: string): string {
	return createHash("md5").update(text).digest("hex");
}

async function refreshPersonaNavigation(dataDir: string): Promise<void> {
	const personaPath = path.join(dataDir, "persona.md");
	let body: string;
	try {
		body = stripSceneNavigation(await fs.readFile(personaPath, "utf-8")).trim();
	} catch {
		return;
	}

	if (!body) return;

	const index = await readSceneIndex(dataDir);
	const nav = generateSceneNavigation(index);
	const finalContent = nav ? `${body}\n\n${nav}\n` : `${body}\n`;
	await fs.writeFile(personaPath, finalContent, "utf-8");
}

export async function listLocalProfiles(
	dataDir: string,
	page?: { offset: number; limit: number },
): Promise<{ profiles: ProfileRecord[]; nextOffset?: number }> {
	const root = await fs.realpath(dataDir);
	const files: Array<{ filename: string; type: "l2" | "l3"; filePath: string }> = [];
	const blocksDir = path.join(root, "scene_blocks");
	try {
		if ((await fs.lstat(blocksDir)).isSymbolicLink()) throw new Error("Unsafe memory profile directory");
		for (const filename of (await fs.readdir(blocksDir)).filter((file) => file.endsWith(".md")).sort()) {
			files.push({ filename, type: "l2", filePath: path.join(blocksDir, filename) });
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const personaPath = path.join(root, "persona.md");
	try {
		await fs.lstat(personaPath);
		files.push({ filename: "persona.md", type: "l3", filePath: personaPath });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const offset = page?.offset ?? 0;
	const selected = files.slice(offset, page ? offset + page.limit : undefined);
	const profiles: ProfileRecord[] = [];
	for (const { filename, type, filePath } of selected) {
		if (!(await fs.lstat(filePath)).isFile()) throw new Error("Unsafe memory profile file");
		const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > 262_144) throw new Error("Memory profile exceeds read limit");
			const raw = await handle.readFile("utf-8");
			const content = type === "l3" ? stripSceneNavigation(raw).trim() : raw;
			if (type === "l3" && !content) continue;
			profiles.push({
				id: buildProfileStableId(PROFILE_SCOPE, type, filename),
				type,
				filename,
				content,
				contentMd5: md5(content),
				version: 0,
				createdAtMs: Math.floor(stat.birthtimeMs || stat.ctimeMs),
				updatedAtMs: Math.floor(stat.mtimeMs),
			});
		} finally {
			await handle.close();
		}
	}
	const nextOffset = offset + selected.length;
	return { profiles, ...(nextOffset < files.length ? { nextOffset } : {}) };
}

export async function pullProfilesToLocal(
	dataDir: string,
	store: IMemoryStore,
	logger: Logger,
): Promise<Map<string, ProfileBaseline>> {
	if (!store.pullProfiles) return new Map();

	const records = await store.pullProfiles();
	const baseline = new Map<string, ProfileBaseline>();
	const tempDir = await fs.mkdtemp(path.join(dataDir, ".profiles-pull-"));
	const tempBlocksDir = path.join(tempDir, "scene_blocks");
	await fs.mkdir(tempBlocksDir, { recursive: true });

	try {
		for (const record of records) {
			baseline.set(record.id, {
				version: record.version,
				contentMd5: record.contentMd5,
				createdAtMs: record.createdAtMs,
			});

			if (record.type === "l2") {
				const target = path.join(tempBlocksDir, record.filename);
				await fs.writeFile(target, record.content, "utf-8");
				if (md5(record.content) !== record.contentMd5) {
					await fs.rm(target, { force: true });
					logger.debug?.(
						`[memory-tdai][profile-sync] MD5 mismatch for ${record.filename} (will re-pull on next sync)`,
					);
				}
				continue;
			}

			if (record.type === "l3") {
				const body = stripSceneNavigation(record.content).trim();
				await fs.writeFile(path.join(tempDir, "persona.md"), body, "utf-8");
				if (md5(body) !== record.contentMd5) {
					await fs.rm(path.join(tempDir, "persona.md"), { force: true });
					logger.debug?.(
						`[memory-tdai][profile-sync] MD5 mismatch for ${record.filename} (will re-pull on next sync)`,
					);
				}
			}
		}

		const localBlocksDir = path.join(dataDir, "scene_blocks");
		await fs.rm(localBlocksDir, { recursive: true, force: true });
		await fs.mkdir(path.dirname(localBlocksDir), { recursive: true });
		try {
			await fs.rename(tempBlocksDir, localBlocksDir);
		} catch (err) {
			if (isRenameRaceError(err)) {
				// Another concurrent pull already wrote scene_blocks — ours is redundant.
				// Both pulls fetched the same remote snapshot, so the other result is equivalent.
				logger.debug?.(
					`[memory-tdai][profile-sync] scene_blocks rename lost race (${(err as NodeJS.ErrnoException).code}), using existing`,
				);
				return baseline;
			}
			throw err;
		}

		const tempPersonaPath = path.join(tempDir, "persona.md");
		const localPersonaPath = path.join(dataDir, "persona.md");
		try {
			await fs.access(tempPersonaPath);
			await fs.rm(localPersonaPath, { force: true });
			try {
				await fs.rename(tempPersonaPath, localPersonaPath);
			} catch (err) {
				if (!isRenameRaceError(err)) throw err;
				logger.debug?.(`[memory-tdai][profile-sync] persona.md rename lost race, using existing`);
			}
		} catch (err) {
			// No temp persona file → remove local persona (remote has none)
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				await fs.rm(localPersonaPath, { force: true });
			} else if (!isRenameRaceError(err)) {
				throw err;
			}
		}

		await syncSceneIndex(dataDir);
		await refreshPersonaNavigation(dataDir);
		logger.debug?.(
			`[memory-tdai][profile-sync] Pulled ${records.length} profile(s) to local cache`,
		);
		return baseline;
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

export async function syncLocalProfilesToStore(
	dataDir: string,
	store: IMemoryStore,
	baselineMap: Map<string, ProfileBaseline>,
	logger: Logger,
): Promise<void> {
	const { profiles: localProfiles } = await listLocalProfiles(dataDir);
	const localIds = new Set(localProfiles.map((profile) => profile.id));

	const syncRecords: ProfileSyncRecord[] = localProfiles
		.filter(
			(profile) =>
				baselineMap.get(profile.id)?.contentMd5 !== profile.contentMd5 ||
				!baselineMap.has(profile.id),
		)
		.map((profile) => ({
			...profile,
			baselineVersion: baselineMap.get(profile.id)?.version,
		}));

	if (syncRecords.length > 0 && store.syncProfiles) {
		await store.syncProfiles(syncRecords);
		logger.info(`[memory-tdai][profile-sync] Synced ${syncRecords.length} changed profile(s)`);
	}

	const deletedIds = [...baselineMap.keys()].filter((id) => !localIds.has(id));
	if (deletedIds.length > 0 && store.deleteProfiles) {
		await store.deleteProfiles(deletedIds);
		logger.info(`[memory-tdai][profile-sync] Deleted ${deletedIds.length} stale profile(s)`);
	}
}

export async function ensureL2L3Local(
	dataDir: string,
	store: IMemoryStore,
	logger: Logger,
): Promise<Map<string, ProfileBaseline>> {
	if (!store.pullProfiles) return new Map();
	return pullProfilesToLocal(dataDir, store, logger);
}
