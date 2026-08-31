// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		const legacy = join(root, "bear-presentation-legacy");
		const abandoned = join(root, "bear-presentation-999-abandoned");
		const live = join(root, "bear-presentation-777-live");
		await Promise.all([mkdir(legacy), mkdir(abandoned), mkdir(live)]);
		await Promise.all([
			writeFile(join(legacy, "private.txt"), "legacy private copy"),
			writeFile(join(abandoned, "private.txt"), "abandoned private copy"),
			writeFile(join(live, "private.txt"), "live private copy"),
		]);
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
		await expect(stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await stat(live)).isDirectory()).toBe(true);
	});

	it("maps shell open failures to unsupported without leaking a failed copy", async () => {
		openPath.mockResolvedValue("No application can open this file");
		const request = makeRequest(root, "report.txt", "contents");

		await expect(handle.presenter.open?.(request)).resolves.toEqual({ outcome: "unsupported" });
		const failedPath = openPath.mock.calls[0]?.[0] as string;
		await expect(stat(failedPath)).rejects.toMatchObject({ code: "ENOENT" });
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
		showSaveDialog.mockResolvedValue({ canceled: true });
		const request = makeRequest(root, "report.txt", "contents");
		const materialize = vi.spyOn(request.access, "withMaterializedFile");

		await expect(handle.presenter.saveAs?.(request)).resolves.toEqual({ outcome: "cancelled" });
		expect(materialize).not.toHaveBeenCalled();
	});

	it("copies to the one-time native save target and returns no path", async () => {
		const destination = join(root, "chosen", "saved.txt");
		await mkdir(join(root, "chosen"));
		showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
		const request = makeRequest(root, "report.txt", "saved contents");

		const outcome = await handle.presenter.saveAs?.(request);

		expect(outcome).toEqual({ outcome: "completed" });
		expect(Object.keys(outcome ?? {})).toEqual(["outcome"]);
		expect(await readFile(destination, "utf8")).toBe("saved contents");
		expect(showSaveDialog).toHaveBeenCalledWith({
			title: "Save artifact",
			defaultPath: join(documents, "report.txt"),
			buttonLabel: "Save",
			properties: ["createDirectory", "showOverwriteConfirmation"],
		});
	});

	it("maps native dialog and copy failures to unsupported", async () => {
		const request = makeRequest(root, "report.txt", "contents");
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
