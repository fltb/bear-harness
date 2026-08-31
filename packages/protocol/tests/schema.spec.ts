import { describe, expect, it } from "vitest";
import {
	ArtifactReadRequest,
	ArtifactSummary,
	MAX_ARTIFACT_READ_BYTES,
	PiSessionLiveEvent,
	RPC,
	Run,
} from "../src/schema.js";

describe("protocol authority boundaries", () => {
	it("keeps only embedding configuration under the memory RPC namespace", () => {
		expect(Object.keys(RPC.memory).sort()).toEqual([
			"cancelLocalEmbeddingDownload",
			"configureLocalEmbedding",
			"localEmbeddingDownloadStatus",
		]);
	});

	it("does not expose Host-owned conversation memory mutation endpoints", () => {
		const channels = JSON.stringify(RPC);
		for (const obsolete of [
			"memory.capture:v1",
			"memory.edit:v1",
			"memory.exclude:v1",
			"memory.forget:v1",
			"memory.list:v1",
			"memory.search:v1",
		]) {
			expect(channels).not.toContain(obsolete);
		}
	});

	it("keeps Pi streaming on a bounded transient projection", () => {
		expect(
			PiSessionLiveEvent.parse({
				sessionId: "session-1",
				type: "message_update",
				live: {
					isStreaming: true,
					streamingMessage: { text: "partial", stopReason: "pending" },
					queuedUserMessages: [],
				},
			}),
		).toMatchObject({ sessionId: "session-1", type: "message_update" });
		expect(
			PiSessionLiveEvent.safeParse({
				sessionId: "session-1",
				type: "host_reconstructed_turn",
				live: { isStreaming: false, queuedUserMessages: [] },
			}),
		).toMatchObject({ success: false });
	});

	it("requires every Artifact read and native action to carry all ownership ids", () => {
		expect(Object.keys(RPC.artifact).sort()).toEqual(["open", "read", "reveal", "saveAs"]);
		expect(
			ArtifactReadRequest.safeParse({
				conversationId: "conversation-1",
				runId: "run-1",
				artifactId: "artifact-1",
				length: MAX_ARTIFACT_READ_BYTES,
			}),
		).toMatchObject({ success: true });
		expect(
			ArtifactReadRequest.safeParse({ runId: "run-1", artifactId: "artifact-1" }),
		).toMatchObject({ success: false });
	});

	it("bounds Artifact provenance and Run evidence on the wire", () => {
		const artifact = {
			id: "artifact-1",
			name: "report.txt",
			mime: "text/plain",
			bytes: 10,
			sha256: "a".repeat(64),
			status: "verified" as const,
			createdAt: "2026-08-31T00:00:00.000Z",
		};
		expect(ArtifactSummary.safeParse(artifact)).toMatchObject({ success: true });
		expect(ArtifactSummary.safeParse({ ...artifact, sha256: "internal/path" })).toMatchObject({
			success: false,
		});
		const run = {
			id: "run-1",
			conversationId: "conversation-1",
			triggerEntryId: "entry-1",
			executorProfile: "codex",
			title: "Build report",
			status: "completed" as const,
			artifacts: [artifact],
			summary: "Report generated",
			evidence: Array.from({ length: 20 }, (_, index) => ({
				kind: "acp.tool_call",
				summary: `status: completed ${index}`,
				createdAt: "2026-08-31T00:00:00.000Z",
			})),
		};
		expect(Run.safeParse(run)).toMatchObject({ success: true });
		expect(
			Run.safeParse({
				...run,
				evidence: [...run.evidence, run.evidence[0]],
			}),
		).toMatchObject({ success: false });
	});

	it("accepts a remote embedding key only on settings writes", () => {
		const remote = {
			enabled: true,
			provider: "remote" as const,
			baseUrl: "https://embedding.example/v1",
			model: "embedding-model",
			dimensions: 768,
		};
		expect(
			RPC.settings.set.request.safeParse({
				settings: { memoryVectorService: { ...remote, apiKey: "write-only-secret" } },
			}),
		).toMatchObject({ success: true });
		const response = {
			settings: {
				firstRunStage: "role" as const,
				relationshipMemoryEnabled: true,
				networkProxy: { mode: "auto" as const },
				memoryVectorService: { ...remote, hasCredential: true },
				modelDownloadSource: { type: "official" as const },
			},
		};
		expect(RPC.settings.get.response.safeParse(response)).toMatchObject({ success: true });
		expect(
			RPC.settings.get.response.safeParse({
				settings: {
					...response.settings,
					memoryVectorService: { ...remote, apiKey: "write-only-secret" },
				},
			}),
		).toMatchObject({ success: false });
	});

	it("models character runtime and package deletion as separate guarded operations", () => {
		expect(Object.keys(RPC.character)).toEqual(
			expect.arrayContaining(["deletionStatusGet", "runtimeDelete", "packageDelete"]),
		);
		expect(
			RPC.character.deletionStatusGet.response.parse({
				status: {
					characterId: "inactive-role",
					active: false,
					default: false,
					runtimePresent: true,
					packagePresent: true,
				},
			}),
		).toEqual({
			status: {
				characterId: "inactive-role",
				active: false,
				default: false,
				runtimePresent: true,
				packagePresent: true,
			},
		});
		expect(
			RPC.character.runtimeDelete.response.safeParse({
				characterId: "inactive-role",
				target: "runtime",
				deleted: true,
			}),
		).toMatchObject({ success: true });
		expect(
			RPC.character.packageDelete.response.safeParse({
				characterId: "inactive-role",
				target: "runtime",
				deleted: true,
			}),
		).toMatchObject({ success: false });
		expect(
			RPC.character.runtimeDelete.request.safeParse({ characterId: "../outside" }),
		).toMatchObject({ success: false });
	});
});
