import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SAFE_COMPANION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function requireCompanionId(companionId: string): string {
	if (
		!SAFE_COMPANION_ID.test(companionId) ||
		companionId === "." ||
		companionId === ".." ||
		isAbsolute(companionId)
	) {
		throw new TypeError("companionId is not a safe path component");
	}
	return companionId;
}

function contained(root: string, ...parts: string[]): string {
	const canonicalRoot = resolve(root);
	const candidate = resolve(canonicalRoot, ...parts);
	const child = relative(canonicalRoot, candidate);
	if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		throw new TypeError("runtime layout path escapes its root");
	}
	return candidate;
}

function assertRealDirectory(path: string, label: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	}
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new TypeError(`${label} must be a real directory`);
	}
}

function isMissing(error: unknown): boolean {
	return (
		error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

function syncDirectory(path: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		fsyncSync(descriptor);
	} catch (error) {
		if (process.platform !== "win32") throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/** Delete one validated direct-child directory without ever following a replacement root symlink. */
export function removeOwnedDirectorySync(root: string, component: string, label: string): boolean {
	const id = requireCompanionId(component);
	const rootStat = lstatSync(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new TypeError(`${label} root must be a real directory`);
	}
	const canonicalRoot = realpathSync(root);
	const target = contained(root, id);
	let targetStat: ReturnType<typeof lstatSync>;
	try {
		targetStat = lstatSync(target);
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
	if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
		throw new TypeError(`${label} must be a real directory`);
	}
	const canonicalTarget = realpathSync(target);
	if (relative(canonicalRoot, canonicalTarget) !== id) {
		throw new TypeError(`${label} path escapes its root`);
	}
	try {
		// Recursive removal unlinks descendant symlinks; it does not traverse their targets.
		rmSync(target, { recursive: true, force: false });
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
	syncDirectory(root);
	return true;
}

function ownedDirectoryExists(root: string, component: string, label: string): boolean {
	const id = requireCompanionId(component);
	let stat: ReturnType<typeof lstatSync>;
	const path = contained(root, id);
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new TypeError(`${label} must be a real directory`);
	}
	return true;
}

export interface CompanionPaths {
	readonly id: string;
	readonly root: string;
	readonly database: string;
	readonly sessions: string;
	readonly memory: string;
	readonly explicitMemory: string;
	readonly tdaiMemory: string;
	readonly runs: string;
	readonly artifacts: string;
	readonly audit: string;
	readonly diagnostics: string;
}

/** One authoritative path assembly point for all installation and character data. */
export class RuntimeLayout {
	readonly root: string;
	readonly systemRoot: string;
	readonly systemDatabase: string;
	readonly systemSecurity: string;
	readonly systemProviders: string;
	readonly systemEmbeddingModels: string;
	readonly systemUpdates: string;
	readonly systemDiagnostics: string;
	readonly charactersRoot: string;
	readonly companionsRoot: string;

	constructor(root: string) {
		if (!isAbsolute(root)) throw new TypeError("runtime data root must be absolute");
		this.root = resolve(root);
		this.systemRoot = contained(this.root, "system");
		this.systemDatabase = contained(this.systemRoot, "settings.db");
		this.systemSecurity = contained(this.systemRoot, "security");
		this.systemProviders = contained(this.systemRoot, "providers");
		this.systemEmbeddingModels = contained(this.systemRoot, "models", "embeddings");
		this.systemUpdates = contained(this.systemRoot, "updates");
		this.systemDiagnostics = contained(this.systemRoot, "diagnostics");
		this.charactersRoot = contained(this.root, "characters");
		this.companionsRoot = contained(this.root, "companions");
	}

	companion(companionId: string): CompanionPaths {
		const id = requireCompanionId(companionId);
		const root = contained(this.companionsRoot, id);
		const memory = contained(root, "memory");
		return Object.freeze({
			id,
			root,
			database: contained(root, "runtime.db"),
			sessions: contained(root, "sessions"),
			memory,
			explicitMemory: contained(memory, "MEMORY.md"),
			tdaiMemory: contained(memory, "tdai"),
			runs: contained(root, "runs"),
			artifacts: contained(root, "artifacts"),
			audit: contained(root, "audit"),
			diagnostics: contained(root, "diagnostics"),
		});
	}

	characterPackage(companionId: string): string {
		return contained(this.charactersRoot, requireCompanionId(companionId));
	}

	hasCompanionRuntime(companionId: string): boolean {
		return ownedDirectoryExists(this.companionsRoot, companionId, "companion runtime directory");
	}

	removeCompanionRuntime(companionId: string): boolean {
		return removeOwnedDirectorySync(
			this.companionsRoot,
			companionId,
			"companion runtime directory",
		);
	}

	ensureSystemDirectories(): void {
		assertRealDirectory(this.root, "runtime data root");
		for (const directory of [
			this.systemRoot,
			this.systemSecurity,
			this.systemProviders,
			this.systemEmbeddingModels,
			this.systemUpdates,
			this.systemDiagnostics,
			this.charactersRoot,
			this.companionsRoot,
		]) {
			assertRealDirectory(directory, "runtime layout directory");
		}
	}

	ensureCompanionDirectories(companionId: string): CompanionPaths {
		const paths = this.companion(companionId);
		for (const directory of [
			paths.root,
			paths.sessions,
			paths.memory,
			paths.tdaiMemory,
			paths.runs,
			paths.artifacts,
			paths.audit,
			paths.diagnostics,
		]) {
			assertRealDirectory(directory, "companion runtime directory");
		}
		return paths;
	}
}
