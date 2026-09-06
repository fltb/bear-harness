// @vitest-environment node

import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HostRuntimeOptions } from "@bear-harness/host-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDesktopArtifactPresenter,
	type DesktopArtifactPresenterHandle,
} from "../src/main/artifact-presenter.js";

type Presenter = NonNullable<HostRuntimeOptions["artifactPresenter"]>;
type PresentationRequest = Parameters<NonNullable<Presenter["open"]>>[0];

describe("desktop artifact presenter", () => {
	let root: string;
	let documents: string;
	let handle: DesktopArtifactPresenterHandle;
	const showSaveDialog = vi.fn();
	const openPath = vi.fn();
	const showItemInFolder = vi.fn();

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "bear-presenter-test-"));
		documents = join(root, "documents");
		showSaveDialog.mockReset();
		openPath.mockReset();
		showItemInFolder.mockReset();
		handle = createDesktopArtifactPresenter({
			showSaveDialog,
			openPath,
			showItemInFolder,
			documentsDirectory: () => documents,
			temporaryDirectory: root,
			uniqueId: () => "fixed-id",
		});
	});

	afterEach(async () => {
		await handle.dispose();
		await rm(root, { recursive: true, force: true });
	});

	it("opens a private copy that outlives the verified source until process cleanup", async () => {
		const sourcePaths: string[] = [];
		const request = makeRequest(root, "../unsafe\\report.pdf", "verified bytes", sourcePaths);
		openPath.mockImplementation(async (path: string) => {
			expect(await readFile(path, "utf8")).toBe("verified bytes");
			return "";
		});

		await expect(handle.presenter.open?.(request)).resolves.toEqual({ outcome: "completed" });
		const presentedPath = openPath.mock.calls[0]?.[0] as string;
		expect(presentedPath).toMatch(/fixed-id-1-unsafe_report\.pdf$/);
		expect(await readFile(presentedPath, "utf8")).toBe("verified bytes");
		await expect(stat(sourcePaths[0] as string)).rejects.toMatchObject({ code: "ENOENT" });
		if (process.platform !== "win32") {
			expect((await stat(presentedPath)).mode & 0o777).toBe(0o600);
			expect((await stat(join(presentedPath, ".."))).mode & 0o777).toBe(0o700);
		}

		await handle.dispose();
		await expect(stat(presentedPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes abandoned presentation copies without touching a live process directory", async () => {
		await handle.dispose();
		const abandoned = join(root, "bear-presentation-999-abandoned");
		const live = join(root, "bear-presentation-777-live");
		const current = join(root, "bear-presentation-123-current");
		const unknown = join(root, "bear-presentation-unowned");
		const unrelated = join(root, "other-application");
		const ordinaryFile = join(root, "bear-presentation-999-file");
		const linked = join(root, "bear-presentation-999-link");
		await Promise.all([mkdir(abandoned), mkdir(live)]);
		await Promise.all([
			writeFile(join(abandoned, "private.txt"), "abandoned private copy"),
			writeFile(join(live, "private.txt"), "live private copy"),
		]);
		await Promise.all([mkdir(current), mkdir(unknown), mkdir(unrelated)]);
		await writeFile(ordinaryFile, "not a presentation directory");
		await writeFile(join(unrelated, "private.txt"), "unrelated bytes");
		await symlink(unrelated, linked, "junction");
		handle = createDesktopArtifactPresenter({
			showSaveDialog,
			openPath: vi.fn(async () => ""),
			showItemInFolder,
			documentsDirectory: () => documents,
			temporaryDirectory: root,
			uniqueId: () => "cleanup-id",
			processId: 123,
			isProcessAlive: (id) => id === 777,
		});

		await expect(
			handle.presenter.open?.(makeRequest(root, "report.txt", "contents")),
		).resolves.toEqual({ outcome: "completed" });
		await expect(stat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await stat(live)).isDirectory()).toBe(true);
		expect((await stat(current)).isDirectory()).toBe(true);
		expect((await stat(unknown)).isDirectory()).toBe(true);
		expect(await readFile(ordinaryFile, "utf8")).toBe("not a presentation directory");
		expect(await readFile(join(linked, "private.txt"), "utf8")).toBe("unrelated bytes");
		expect(await readFile(join(unrelated, "private.txt"), "utf8")).toBe("unrelated bytes");
	});

	it("maps shell open failures to unsupported without leaking a failed copy", async () => {
		openPath.mockResolvedValue("No application can open this file");
		const request = makeRequest(root, "report.txt", "contents");

		await expect(handle.presenter.open?.(request)).resolves.toEqual({ outcome: "unsupported" });
		const failedPath = openPath.mock.calls[0]?.[0] as string;
		await expect(stat(failedPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes only the failed copy when native open rejects", async () => {
		openPath.mockResolvedValueOnce("");
		const retained = makeRequest(root, "report.txt", "already opened bytes");
		await expect(handle.presenter.open?.(retained)).resolves.toEqual({ outcome: "completed" });
		const retainedPath = openPath.mock.calls[0]?.[0] as string;
		openPath.mockRejectedValueOnce(new Error("native shell unavailable"));

		await expect(
			handle.presenter.open?.(makeRequest(root, "report.txt", "failed private bytes")),
		).resolves.toEqual({ outcome: "unsupported" });
		const failedPath = openPath.mock.calls[1]?.[0] as string;
		await expect(stat(failedPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(retainedPath, "utf8")).toBe("already opened bytes");
	});

	it("maps reveal exceptions to unsupported instead of crashing", async () => {
		showItemInFolder.mockImplementation(() => {
			throw new Error("native shell unavailable");
		});
		const request = makeRequest(root, "report.txt", "contents");

		await expect(handle.presenter.reveal?.(request)).resolves.toEqual({
			outcome: "unsupported",
		});
		const failedPath = showItemInFolder.mock.calls[0]?.[0] as string;
		await expect(stat(failedPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("returns cancelled without materializing when the native save dialog is cancelled", async () => {
		const destination = join(root, "existing.txt");
		await writeFile(destination, "original bytes");
		showSaveDialog.mockResolvedValue({ canceled: true, filePath: destination });
		const sourcePaths: string[] = [];
		const request = makeRequest(root, "report.txt", "replacement bytes", sourcePaths);

		await expect(handle.presenter.saveAs?.(request)).resolves.toEqual({ outcome: "cancelled" });
		expect(await readFile(destination, "utf8")).toBe("original bytes");
		expect(sourcePaths).toEqual([]);
	});

	it("copies to the one-time native save target and returns no path", async () => {
		const destination = join(root, "chosen", "saved.txt");
		await mkdir(join(root, "chosen"));
		showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
		const request = makeRequest(root, "report.txt", "saved contents");

		const outcome = await handle.presenter.saveAs?.(request);

		expect(outcome).toEqual({ outcome: "completed" });
		expect(await readFile(destination, "utf8")).toBe("saved contents");
	});

	it("maps native dialog and copy failures to unsupported", async () => {
		const sourcePaths: string[] = [];
		const request = makeRequest(root, "report.txt", "contents", sourcePaths);
		showSaveDialog.mockRejectedValueOnce(new Error("dialog unavailable"));
		await expect(handle.presenter.saveAs?.(request)).resolves.toEqual({
			outcome: "unsupported",
		});

		showSaveDialog.mockResolvedValueOnce({
			canceled: false,
			filePath: join(root, "missing", "report.txt"),
		});
		await expect(handle.presenter.saveAs?.(request)).resolves.toEqual({
			outcome: "unsupported",
		});
		await expect(stat(sourcePaths[0] as string)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(root)).toEqual([]);
	});

	it("treats an accepted dialog with no target as unsupported without creating files", async () => {
		showSaveDialog.mockResolvedValue({ canceled: false });
		await expect(
			handle.presenter.saveAs?.(makeRequest(root, "report.txt", "contents")),
		).resolves.toEqual({ outcome: "unsupported" });
		expect(await readdir(root)).toEqual([]);
	});

	it.each(["open", "reveal", "saveAs"] as const)(
		"does not publish or overwrite bytes when %s is denied materialized access",
		async (action) => {
			const destination = join(root, "existing.txt");
			await writeFile(destination, "original bytes");
			showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
			const request = makeRequest(root, "report.txt", "unavailable bytes");
			request.access.withMaterializedFile = async () => {
				throw new Error("artifact_presentation_access_expired");
			};

			await expect(handle.presenter[action]?.(request)).resolves.toEqual({
				outcome: "unsupported",
			});
			expect(await readFile(destination, "utf8")).toBe("original bytes");
			expect(openPath).not.toHaveBeenCalled();
			expect(showItemInFolder).not.toHaveBeenCalled();
			for (const entry of await readdir(root, { withFileTypes: true })) {
				if (entry.isDirectory()) expect(await readdir(join(root, entry.name))).toEqual([]);
			}
		},
	);

	it("removes a copied file if materialized access fails while releasing its source", async () => {
		const sourcePaths: string[] = [];
		const request = makeRequest(root, "report.txt", "private bytes", sourcePaths);
		const materialize = request.access.withMaterializedFile;
		request.access.withMaterializedFile = (use) =>
			materialize(async (source) => {
				await use(source);
				throw new Error("materialization cleanup failed");
			});

		await expect(handle.presenter.open?.(request)).resolves.toEqual({ outcome: "unsupported" });
		expect(openPath).not.toHaveBeenCalled();
		await expect(stat(sourcePaths[0] as string)).rejects.toMatchObject({ code: "ENOENT" });
		for (const entry of await readdir(root)) {
			expect(await readdir(join(root, entry))).toEqual([]);
		}
	});

	it("can present after a temporary-root obstruction is removed", async () => {
		await handle.dispose();
		const temporaryRoot = join(root, "presentation-root");
		await writeFile(temporaryRoot, "obstruction");
		handle = createDesktopArtifactPresenter({
			showSaveDialog,
			openPath,
			showItemInFolder,
			documentsDirectory: () => documents,
			temporaryDirectory: temporaryRoot,
		});
		const request = makeRequest(root, "report.txt", "verified bytes");
		await expect(handle.presenter.open?.(request)).resolves.toEqual({ outcome: "unsupported" });
		expect(await readFile(temporaryRoot, "utf8")).toBe("obstruction");

		await rm(temporaryRoot);
		openPath.mockResolvedValue("");
		await expect(handle.presenter.open?.(request)).resolves.toEqual({ outcome: "completed" });
		expect(await readFile(openPath.mock.calls[0]?.[0] as string, "utf8")).toBe("verified bytes");
	});

	it("keeps repeated reveals distinct and confined despite unsafe path components", async () => {
		await handle.dispose();
		handle = createDesktopArtifactPresenter({
			showSaveDialog,
			openPath,
			showItemInFolder,
			documentsDirectory: () => documents,
			temporaryDirectory: root,
			uniqueId: () => "../../outside",
		});
		for (const contents of ["first bytes", "second bytes"]) {
			await expect(handle.presenter.reveal?.(makeRequest(root, "..", contents))).resolves.toEqual({
				outcome: "completed",
			});
		}
		const first = showItemInFolder.mock.calls[0]?.[0] as string;
		const second = showItemInFolder.mock.calls[1]?.[0] as string;
		expect(dirname(dirname(first))).toBe(root);
		expect(dirname(second)).toBe(dirname(first));
		expect(await readFile(first, "utf8")).toBe("first bytes");
		expect(await readFile(second, "utf8")).toBe("second bytes");
		await handle.dispose();
		await expect(stat(first)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(second)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not recreate private files or overwrite a save target after disposal", async () => {
		const destination = join(root, "existing.txt");
		await writeFile(destination, "original bytes");
		showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
		await handle.dispose();
		const request = makeRequest(root, "report.txt", "replacement bytes");
		for (const action of ["open", "reveal", "saveAs"] as const) {
			await expect(handle.presenter[action]?.(request)).resolves.toEqual({
				outcome: "unsupported",
			});
		}
		expect(await readdir(root)).toEqual(["existing.txt"]);
		expect(await readFile(destination, "utf8")).toBe("original bytes");
	});
});

function makeRequest(
	root: string,
	logicalName: string,
	contents: string,
	sourcePaths: string[] = [],
): PresentationRequest {
	return {
		artifact: {
			id: "artifact-1",
			logicalName,
			mime: "text/plain",
			bytes: Buffer.byteLength(contents),
			sha256: "a".repeat(64),
			status: "verified",
			producerRunId: "run-1",
			createdAt: "2026-08-31T00:00:00.000Z",
		},
		access: {
			read: () => {
				throw new Error("unused");
			},
			async withMaterializedFile<T>(use: (path: string) => T | Promise<T>): Promise<T> {
				const source = join(root, `verified-source-${sourcePaths.length}`);
				sourcePaths.push(source);
				await writeFile(source, contents, { mode: 0o600 });
				try {
					return await use(source);
				} finally {
					await rm(source, { force: true });
				}
			},
		},
	};
}
