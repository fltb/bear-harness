// @vitest-environment node

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts/index.js";
import type {
	ArtifactPresentationAccess,
	ArtifactPresenter,
} from "../src/artifacts/presentation.js";
import { type HostCompositionContext, wireHostHandlers } from "../src/composition.js";
import { Dispatcher } from "../src/dispatcher.js";
import { COMPANION_SCHEMA_SQL, CompanionDatabase } from "../src/storage/database.js";
import { artifacts, conversations, evidence, runs } from "../src/storage/schema.js";

interface ArtifactIdentity {
	conversationId: string;
	runId: string;
	artifactId: string;
}

describe("run-owned Artifact RPC", () => {
	let root: string;
	let database: CompanionDatabase;
	let store: ArtifactStore;
	let dispatcher: Dispatcher;
	let context: HostCompositionContext;
	let first: ArtifactIdentity;
	let second: ArtifactIdentity;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bear-artifact-rpc-"));
		database = new CompanionDatabase(join(root, "runtime.db"), "bear");
		database.initialize(COMPANION_SCHEMA_SQL);
		database.ensureRuntimeIdentity();
		store = new ArtifactStore(database.orm, join(root, "cas"));
		first = seedRunArtifact("conversation-a", "run-a", "artifact-a.txt", "0123456789");
		second = seedRunArtifact("conversation-b", "run-b", "artifact-b.txt", "other data");
		context = compositionContext();
		dispatcher = new Dispatcher();
		wireHostHandlers(dispatcher, context);
	});

	afterEach(() => {
		database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("reads bounded ranges with authoritative metadata and EOF offsets", async () => {
		await expect(
			dispatcher.dispatch("artifact.read:v1", { ...first, offset: 2, length: 4 }),
		).resolves.toEqual({
			ok: true,
			data: {
				artifact: {
					id: first.artifactId,
					name: "artifact-a.txt",
					mime: "text/plain",
					bytes: 10,
					sha256: store.get(first.artifactId)?.sha256,
					status: "created",
					createdAt: expect.any(String),
				},
				offset: 2,
				nextOffset: 6,
				eof: false,
				base64: Buffer.from("2345").toString("base64"),
			},
		});
		await expect(
			dispatcher.dispatch("artifact.read:v1", { ...first, offset: 8, length: 100 }),
		).resolves.toMatchObject({
			ok: true,
			data: {
				offset: 8,
				nextOffset: 10,
				eof: true,
				base64: Buffer.from("89").toString("base64"),
			},
		});
		await expect(
			dispatcher.dispatch("artifact.read:v1", { ...first, offset: 12, length: 1 }),
		).resolves.toMatchObject({
			ok: true,
			data: { offset: 12, nextOffset: 12, eof: true, base64: "" },
		});
		await expect(
			dispatcher.dispatch("artifact.read:v1", { ...first, length: 1024 * 1024 + 1 }),
		).resolves.toEqual({
			ok: false,
			error: { kind: "invalid_request", reason: "request_validation_failed" },
		});
	});

	it("projects bounded, sanitized provenance only for the owning Run", async () => {
		for (let index = 0; index < 25; index += 1) {
			database.orm
				.insert(evidence)
				.values({
					id: `evidence-a-${index}`,
					runId: first.runId,
					kind: "acp.tool_call",
					data: {
						title: `Read /Users/private/input-${index}`,
						status: "completed",
						password: "must-not-cross-wire",
					},
					createdAt: new Date(Date.UTC(2026, 7, 31, 0, 0, index)).toISOString(),
				})
				.run();
		}
		database.orm
			.insert(evidence)
			.values({
				id: "evidence-b",
				runId: second.runId,
				kind: "other-run-secret",
				data: { title: "must-not-cross-run" },
			})
			.run();
		const row = database.orm.select().from(runs).where(eq(runs.id, first.runId)).get();
		if (!row) throw new Error("missing Run fixture");
		context.externalAgentRuns = {
			pendingPermissions: vi.fn(() => []),
			list: vi.fn(() => [
				{
					...row,
					summary: "Read /Users/private/source with token=must-not-cross-wire",
					artifacts: [store.get(first.artifactId)],
				},
			]),
		} as never;

		const response = await dispatcher.dispatch("run.list:v1", {});
		expect(response).toMatchObject({
			ok: true,
			data: {
				runs: [
					{
						id: first.runId,
						executorProfile: "codex",
						triggerEntryId: `${first.runId}-entry`,
						evidence: expect.arrayContaining([
							expect.objectContaining({
								kind: "acp.tool_call",
								summary: expect.stringContaining("<redacted-path>"),
							}),
						]),
					},
				],
			},
		});
		if (!response.ok) throw new Error("expected successful Run projection");
		const [projected] = (response.data as { runs: Array<{ evidence: unknown[] }> }).runs;
		expect(projected?.evidence).toHaveLength(20);
		expect(JSON.stringify(response)).not.toContain("must-not-cross-wire");
		expect(JSON.stringify(response)).not.toContain("must-not-cross-run");
		expect(JSON.stringify(response)).not.toContain("/Users/private");
	});

	it("rejects cross-conversation and cross-run ownership before presentation", async () => {
		const presenter: ArtifactPresenter = {
			open: vi.fn(() => ({ outcome: "completed" as const })),
		};
		context.artifactPresenter = presenter;

		await expect(
			dispatcher.dispatch("artifact.open:v1", {
				conversationId: first.conversationId,
				runId: second.runId,
				artifactId: second.artifactId,
			}),
		).resolves.toEqual({
			ok: false,
			error: { kind: "not_found", reason: "run_not_found" },
		});
		await expect(
			dispatcher.dispatch("artifact.open:v1", {
				...first,
				artifactId: second.artifactId,
			}),
		).resolves.toEqual({
			ok: false,
			error: { kind: "not_found", reason: "artifact_not_found" },
		});
		await expect(
			dispatcher.dispatch("artifact.open:v1", {
				...first,
				conversationId: "missing-conversation",
			}),
		).resolves.toEqual({
			ok: false,
			error: { kind: "not_found", reason: "conversation_not_found" },
		});
		expect(presenter.open).not.toHaveBeenCalled();
	});

	it("runs integrity validation before reads, actions, or unsupported fallback", async () => {
		const record = store.get(first.artifactId);
		if (!record) throw new Error("missing artifact fixture");
		writeFileSync(join(store.directory, record.sha256), "tampered!");
		const presenter: ArtifactPresenter = {
			open: vi.fn(() => ({ outcome: "completed" as const })),
		};
		context.artifactPresenter = presenter;

		for (const channel of ["artifact.read:v1", "artifact.open:v1"] as const) {
			await expect(dispatcher.dispatch(channel, first)).resolves.toEqual({
				ok: false,
				error: { kind: "internal", reason: "artifact_corrupted" },
			});
		}
		expect(presenter.open).not.toHaveBeenCalled();
		expect(
			database.orm
				.select({ status: artifacts.status })
				.from(artifacts)
				.where(eq(artifacts.id, first.artifactId))
				.get()?.status,
		).toBe("verification_failed");

		context.artifactPresenter = undefined;
		await expect(dispatcher.dispatch("artifact.reveal:v1", first)).resolves.toEqual({
			ok: false,
			error: { kind: "internal", reason: "artifact_corrupted" },
		});
	});

	it("passes controlled capabilities to the presenter and expires them afterwards", async () => {
		let retainedAccess: ArtifactPresentationAccess | undefined;
		let materializedPath = "";
		const presenter: ArtifactPresenter = {
			open: vi.fn(async ({ artifact, access }) => {
				retainedAccess = access;
				expect(artifact).toMatchObject({
					id: first.artifactId,
					logicalName: "artifact-a.txt",
					producerRunId: first.runId,
				});
				expect(access.read(1, 3).buffer).toEqual(Buffer.from("123"));
				return access.withMaterializedFile((path: string) => {
					materializedPath = path;
					expect(readFileSync(path)).toEqual(Buffer.from("0123456789"));
					expect(statSync(path).mode & 0o777).toBe(0o600);
					return { outcome: "completed" as const };
				});
			}),
		};
		context.artifactPresenter = presenter;

		const response = await dispatcher.dispatch("artifact.open:v1", first);
		expect(response).toEqual({ ok: true, data: { outcome: "completed" } });
		expect(materializedPath).not.toBe("");
		expect(existsSync(materializedPath)).toBe(false);
		expect(JSON.stringify(response)).not.toContain(materializedPath);
		expect(() => retainedAccess?.read(0, 1)).toThrow("artifact_presentation_access_expired");
	});

	it("passes action outcomes through and marks only completed saveAs as saved", async () => {
		const saveAs = vi
			.fn<NonNullable<ArtifactPresenter["saveAs"]>>()
			.mockResolvedValueOnce({ outcome: "cancelled" })
			.mockResolvedValueOnce({ outcome: "completed" });
		const presenter: ArtifactPresenter = {
			open: vi.fn(() => ({ outcome: "unsupported" as const })),
			reveal: vi.fn(() => ({ outcome: "cancelled" as const })),
			saveAs,
		};
		context.artifactPresenter = presenter;

		await expect(dispatcher.dispatch("artifact.open:v1", first)).resolves.toEqual({
			ok: true,
			data: { outcome: "unsupported" },
		});
		await expect(dispatcher.dispatch("artifact.reveal:v1", first)).resolves.toEqual({
			ok: true,
			data: { outcome: "cancelled" },
		});
		await expect(dispatcher.dispatch("artifact.saveAs:v1", first)).resolves.toEqual({
			ok: true,
			data: { outcome: "cancelled" },
		});
		expect(store.get(first.artifactId)?.status).toBe("created");
		await expect(dispatcher.dispatch("artifact.saveAs:v1", first)).resolves.toEqual({
			ok: true,
			data: { outcome: "completed" },
		});
		expect(store.get(first.artifactId)?.status).toBe("saved");
	});

	it("returns unsupported for every action when no presenter exists", async () => {
		for (const channel of [
			"artifact.open:v1",
			"artifact.reveal:v1",
			"artifact.saveAs:v1",
		] as const) {
			await expect(dispatcher.dispatch(channel, first)).resolves.toEqual({
				ok: true,
				data: { outcome: "unsupported" },
			});
		}
		expect(store.get(first.artifactId)?.status).toBe("created");
	});

	function seedRunArtifact(
		conversationId: string,
		runId: string,
		logicalName: string,
		content: string,
	): ArtifactIdentity {
		database.orm.insert(conversations).values({ id: conversationId, companionId: "bear" }).run();
		database.orm
			.insert(runs)
			.values({
				id: runId,
				conversationId,
				triggerEntryId: `${runId}-entry`,
				executorProfile: "codex",
				title: runId,
				instruction: "test",
			})
			.run();
		const artifact = store.create({
			logicalName,
			buffer: Buffer.from(content),
			mime: "text/plain",
			producerRunId: runId,
		});
		return { conversationId, runId, artifactId: artifact.id };
	}

	function compositionContext(): HostCompositionContext {
		const character = { id: "bear", state: { type: "object" }, canon: {} };
		return {
			signal: new AbortController().signal,
			systemOrm: {} as never,
			orm: database.orm,
			eventBus: { currentSeq: 0, publish: vi.fn(), after: vi.fn(() => []) } as never,
			onboarding: {
				initialize: vi.fn(),
				getState: vi.fn(() => ({ status: "completed", stateData: { decisions: {} } })),
			} as never,
			pi: { configure: vi.fn() } as never,
			sessions: {} as never,
			models: {} as never,
			appSettings: {} as never,
			memoryEmbedding: {} as never,
			memoryScope: { installationId: "install", userId: "user" },
			externalAgentRuns: {} as never,
			externalAgents: {} as never,
			artifacts: store,
			canon: { syncPackage: vi.fn() } as never,
			providers: {} as never,
			characterLoader: {
				getActiveCharacterId: vi.fn(() => "bear"),
				load: vi.fn(() => character),
			} as never,
			drafts: {} as never,
			companionStore: { reconcileSchema: vi.fn() } as never,
			defaultCharacterId: "bear",
			activateCharacter: vi.fn(),
			seedCharacter: vi.fn(),
		};
	}
});
