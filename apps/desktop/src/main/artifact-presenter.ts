import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { HostRuntimeOptions } from "@bear-harness/host-runtime";

type ArtifactPresenter = NonNullable<HostRuntimeOptions["artifactPresenter"]>;
type ArtifactPresentationRequest = Parameters<NonNullable<ArtifactPresenter["open"]>>[0];
type ArtifactPresentationOutcome = Awaited<ReturnType<NonNullable<ArtifactPresenter["open"]>>>;

export interface DesktopArtifactPresenterDependencies {
	showSaveDialog(options: {
		title: string;
		defaultPath: string;
		buttonLabel: string;
		properties: Array<"createDirectory" | "showOverwriteConfirmation">;
	}): Promise<{ canceled: boolean; filePath?: string }>;
	openPath(path: string): Promise<string>;
	showItemInFolder(path: string): void;
	documentsDirectory(): string;
	temporaryDirectory?: string;
	uniqueId?: () => string;
	processId?: number;
	isProcessAlive?: (processId: number) => boolean;
}

export interface DesktopArtifactPresenterHandle {
	presenter: ArtifactPresenter;
	dispose(): Promise<void>;
}

/**
 * Trusted Electron-main adapter for artifact presentation. Its private paths
 * are consumed only by Electron's dialog/shell APIs and never cross IPC.
 */
export function createDesktopArtifactPresenter(
	dependencies: DesktopArtifactPresenterDependencies,
): DesktopArtifactPresenterHandle {
	const temporaryRoot = dependencies.temporaryDirectory ?? tmpdir();
	const uniqueId = dependencies.uniqueId ?? randomUUID;
	const processId = dependencies.processId ?? process.pid;
	const isProcessAlive = dependencies.isProcessAlive ?? processAlive;
	const cleanupPromise = cleanupStalePresentationDirectories(
		temporaryRoot,
		processId,
		isProcessAlive,
	);
	let directoryPromise: Promise<string> | undefined;
	let closed = false;
	let sequence = 0;
	const active = new Set<Promise<unknown>>();

	const ensureDirectory = (): Promise<string> => {
		if (closed) return Promise.reject(new Error("artifact_presenter_closed"));
		if (!directoryPromise) {
			directoryPromise = cleanupPromise
				.then(() => mkdir(temporaryRoot, { recursive: true }))
				.then(() => mkdtemp(join(temporaryRoot, `bear-presentation-${processId}-`)))
				.then(async (directory) => {
					await chmod(directory, 0o700);
					return directory;
				})
				.catch((error) => {
					directoryPromise = undefined;
					throw error;
				});
		}
		return directoryPromise;
	};

	const track = <T>(operation: () => Promise<T>): Promise<T> => {
		if (closed) return Promise.reject(new Error("artifact_presenter_closed"));
		const task = operation();
		active.add(task);
		void task.finally(() => active.delete(task)).catch(() => undefined);
		return task;
	};

	const copyForPresentation = async (request: ArtifactPresentationRequest): Promise<string> => {
		const directory = await ensureDirectory();
		sequence += 1;
		const destination = join(
			directory,
			`${safeUniqueId(uniqueId())}-${sequence}-${safeFileName(request.artifact.logicalName)}`,
		);
		try {
			await request.access.withMaterializedFile(async (source) => {
				await copyFile(source, destination, constants.COPYFILE_EXCL);
				await chmod(destination, 0o600);
			});
			return destination;
		} catch (error) {
			await rm(destination, { force: true }).catch(() => undefined);
			throw error;
		}
	};

	const open = (request: ArtifactPresentationRequest) =>
		safeOutcome(() =>
			track(async () => {
				const destination = await copyForPresentation(request);
				const shellError = await dependencies.openPath(destination);
				if (shellError) {
					await rm(destination, { force: true });
					return unsupported();
				}
				return completed();
			}),
		);

	const reveal = (request: ArtifactPresentationRequest) =>
		safeOutcome(() =>
			track(async () => {
				const destination = await copyForPresentation(request);
				try {
					dependencies.showItemInFolder(destination);
				} catch (error) {
					await rm(destination, { force: true });
					throw error;
				}
				return completed();
			}),
		);

	const saveAs = async (request: ArtifactPresentationRequest) => {
		let selection: { canceled: boolean; filePath?: string };
		try {
			selection = await dependencies.showSaveDialog({
				title: "Save artifact",
				defaultPath: join(
					dependencies.documentsDirectory(),
					safeFileName(request.artifact.logicalName),
				),
				buttonLabel: "Save",
				properties: ["createDirectory", "showOverwriteConfirmation"],
			});
		} catch {
			return unsupported();
		}
		if (selection.canceled) return cancelled();
		const destination = selection.filePath;
		if (!destination) return unsupported();
		return safeOutcome(() =>
			track(async () => {
				await request.access.withMaterializedFile((source) => copyFile(source, destination));
				return completed();
			}),
		);
	};

	return {
		presenter: Object.freeze({ open, reveal, saveAs }),
		async dispose() {
			if (closed) return;
			closed = true;
			await Promise.allSettled([...active]);
			const directory = await directoryPromise?.catch(() => undefined);
			if (directory) await rm(directory, { recursive: true, force: true });
		},
	};
}

async function cleanupStalePresentationDirectories(
	temporaryRoot: string,
	currentProcessId: number,
	isProcessAlive: (processId: number) => boolean,
): Promise<void> {
	let entries: Dirent<string>[];
	try {
		entries = await readdir(temporaryRoot, { withFileTypes: true });
	} catch {
		return;
	}
	await Promise.all(
		entries.map(async (entry) => {
			if (!entry.isDirectory() || !entry.name.startsWith("bear-presentation-")) return;
			const owner = /^bear-presentation-(\d+)-/.exec(entry.name)?.[1];
			if (!owner) return;
			const ownerProcessId = Number(owner);
			if (ownerProcessId === currentProcessId || isProcessAlive(ownerProcessId)) return;
			await rm(join(temporaryRoot, entry.name), { recursive: true, force: true }).catch(
				() => undefined,
			);
		}),
	);
}

function processAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function safeOutcome(
	operation: () => Promise<ArtifactPresentationOutcome>,
): Promise<ArtifactPresentationOutcome> {
	try {
		return await operation();
	} catch {
		return unsupported();
	}
}

function completed(): ArtifactPresentationOutcome {
	return { outcome: "completed" };
}

function cancelled(): ArtifactPresentationOutcome {
	return { outcome: "cancelled" };
}

function unsupported(): ArtifactPresentationOutcome {
	return { outcome: "unsupported" };
}

function safeUniqueId(value: string): string {
	const safe = [...value]
		.map((character) => (/^[A-Za-z0-9_-]$/.test(character) ? character : "_"))
		.join("")
		.slice(0, 64);
	return safe || randomUUID();
}

function safeFileName(logicalName: string): string {
	const leaf = [...basename(logicalName)]
		.map((character) => {
			const code = character.charCodeAt(0);
			return character === "/" || character === "\\" || code < 32 || code === 127 ? "_" : character;
		})
		.join("")
		.slice(0, 180);
	return leaf && leaf !== "." && leaf !== ".." ? leaf : "artifact";
}
