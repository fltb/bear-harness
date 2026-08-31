import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { RuntimeLayout, requireCompanionId } from "../storage/layout.js";

const MAX_CHARACTERS = 4_000;
const SAFE_SCOPE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface ExplicitMemoryFileHooks {
	syncDirectory?(directory: string): Promise<void>;
}

function requireScopeComponent(name: string, value: string): string {
	if (!SAFE_SCOPE_COMPONENT.test(value) || value === "." || value === "..")
		throw new TypeError(`${name} is not a safe path component`);
	return value;
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(directory, "r");
		await handle.sync();
	} catch (error) {
		if (process.platform !== "win32") throw error;
		const code = (error as NodeJS.ErrnoException).code;
		if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes(code ?? "")) throw error;
	} finally {
		await handle?.close();
	}
}

/** Exact user-authorized memory text. It is deliberately not a TDAI record store. */
export class ExplicitMemoryFile {
	readonly path: string;
	private readonly syncDirectoryHook: (directory: string) => Promise<void>;

	constructor(
		dataDir: string,
		userId: string,
		companionId: string,
		hooks: ExplicitMemoryFileHooks = {},
	) {
		// The current installation/user is represented by the data root. Keep
		// validating userId at the API boundary, but never add another physical
		// partition between a character and its runtime-owned memory.
		requireScopeComponent("userId", userId);
		this.path = new RuntimeLayout(resolve(dataDir)).companion(
			requireCompanionId(companionId),
		).explicitMemory;
		this.syncDirectoryHook = hooks.syncDirectory ?? syncDirectory;
	}

	async read(): Promise<string> {
		try {
			return await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
			throw error;
		}
	}

	async edit(oldText: string | undefined, newText: string): Promise<string> {
		await mkdir(dirname(this.path), { recursive: true });
		const release = await lockfile.lock(this.path, {
			realpath: false,
			retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
		});
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const current = await this.read();
			let next: string;
			if (oldText === undefined) {
				const addition = newText.trim();
				if (!addition) throw new Error("Explicit memory text is empty");
				next = current.trimEnd() ? `${current.trimEnd()}\n${addition}\n` : `${addition}\n`;
			} else {
				if (!oldText) throw new Error("oldText must be omitted for append or contain exact text");
				const first = current.indexOf(oldText);
				if (first < 0) throw new Error("Exact memory text was not found");
				if (current.indexOf(oldText, first + oldText.length) >= 0)
					throw new Error("Exact memory text occurs more than once");
				next = current.slice(0, first) + newText + current.slice(first + oldText.length);
			}
			if (next.length > MAX_CHARACTERS)
				throw new Error(`Explicit memory exceeds ${MAX_CHARACTERS} characters`);
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(next, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, this.path);
			await this.syncDirectoryHook(dirname(this.path));
			return next;
		} finally {
			await rm(temporary, { force: true });
			await release();
		}
	}
}
