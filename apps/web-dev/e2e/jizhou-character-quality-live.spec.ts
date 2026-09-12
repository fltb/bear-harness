import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "playwright/test";
import { parse } from "yaml";
import { projectPiEntries } from "./helpers";

const enabled = process.env.BEAR_E2E_CHARACTER_QUALITY === "1";
const modelId = process.env.BEAR_E2E_MODEL_ID ?? "";
const useCodexSession = process.env.BEAR_E2E_USE_CODEX_SESSION === "1";
const configuredProviderId = "openai-codex";
const replyTimeout = 180_000;
const repositoryRoot = resolve(process.cwd(), "../..");
const defaultCorpusPath = resolve(
	repositoryRoot,
	"docs/evaluations/jizhou-adversarial-corpus-2026-09-12.json",
);
const corpusPath = resolve(process.env.BEAR_E2E_CHARACTER_QUALITY_CORPUS ?? defaultCorpusPath);
const outputPath = process.env.BEAR_E2E_CHARACTER_QUALITY_OUTPUT
	? resolve(process.env.BEAR_E2E_CHARACTER_QUALITY_OUTPUT)
	: "";

interface Corpus {
	characterId: string;
	description: string;
	sessions: Array<{ label: string; prompts: string[] }>;
}

interface OpenConversation {
	branch: { entries: unknown[] };
	live: { isStreaming: boolean };
}

interface CapturedTurn {
	turn: number;
	user: string;
	assistant: string;
	assistantEntryIds: string[];
}

type LiveRpc = <T>(channel: string, data: unknown) => Promise<T>;

function characterSourceHash(): string {
	const hash = createHash("sha256");
	for (const relativePath of [
		"config/characters/jizhou/character.yaml",
		"config/characters/jizhou/canon/manifest.yaml",
		"config/characters/jizhou/canon/jizhou-story.md",
		"config/characters/jizhou/skills/undelivered-report/SKILL.md",
		"config/characters/jizhou/skills/undelivered-report/resources/story.md",
	]) {
		hash.update(relativePath);
		hash.update("\0");
		hash.update(readFileSync(resolve(repositoryRoot, relativePath)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

async function completeOnboarding(rpc: LiveRpc): Promise<void> {
	await rpc("systemOnboarding.completeModel", {
		reply: { providerId: configuredProviderId, modelId },
		vision: { mode: "auto" },
		licensesAcknowledged: {
			bear: "GPL-3.0-only",
			...(process.platform === "win32" ? { gitForWindows: "GPL-2.0-only" } : {}),
		},
	});
	await rpc("systemOnboarding.completeEmbedding", { choice: "none" });
	await rpc("model.defaults.completeOnboarding", {});
	let onboarding = await rpc<{ status: string; currentStepId?: string }>("onboarding.get", {});
	const answers: Record<string, string | undefined> = {
		welcome: undefined,
		nickname: "北辰",
	};
	while (onboarding.status === "active") {
		const stepId = onboarding.currentStepId;
		if (!stepId || !(stepId in answers))
			throw new Error(`Unhandled character onboarding step: ${stepId ?? "missing"}`);
		onboarding = await rpc("onboarding.submit", { stepId, answer: answers[stepId] });
	}
}

test("configured live model answers the Jizhou adversarial character-quality corpus", async ({
	page,
}) => {
	test.skip(
		!enabled || !modelId || !useCodexSession || !outputPath,
		"Set the character-quality flag, Codex session, model id, and output path",
	);
	test.setTimeout(1_800_000);

	const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;
	expect(corpus.characterId).toBe("jizhou");
	expect(corpus.sessions.length).toBeGreaterThanOrEqual(4);
	expect(corpus.sessions.some((session) => session.prompts.length >= 18)).toBe(true);
	const character = parse(
		readFileSync(resolve(repositoryRoot, "config/characters/jizhou/character.yaml"), "utf8"),
	) as { behavior: { examples: Array<{ user: string; assistant: string }> } };
	const evaluationPrompts = corpus.sessions.flatMap((session) => session.prompts);
	const exampleLines = new Set(
		character.behavior.examples.flatMap((example) => [
			example.user.trim(),
			example.assistant.trim(),
		]),
	);
	expect(evaluationPrompts.filter((prompt) => exampleLines.has(prompt.trim()))).toEqual([]);

	await page.goto("/");
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const rpc: LiveRpc = async <T>(channel: string, data: unknown): Promise<T> => {
		const response = await page.request.post(`/rpc/${encodeURIComponent(channel)}`, {
			headers,
			data,
		});
		const envelope = await response.json();
		if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.reason ?? "failed"}`);
		return envelope.data as T;
	};

	await rpc("model.enable", {
		providerId: configuredProviderId,
		modelId,
		label: `Character quality ${modelId}`,
	});
	await rpc("model.defaults.setReply", {
		reply: { providerId: configuredProviderId, modelId },
	});
	await completeOnboarding(rpc);

	const accepted: Array<
		| {
				label: string;
				prompts: string[];
				conversationId: string;
				attempts: number;
				turns: CapturedTurn[];
		  }
		| undefined
	> = new Array(corpus.sessions.length);
	const captureFailures: Array<{
		label: string;
		attempt: number;
		conversationId?: string;
		turns: CapturedTurn[];
		error: string;
	}> = [];
	const metadata = {
		capturedAt: new Date().toISOString(),
		baseCommit: process.env.BEAR_E2E_BASE_COMMIT ?? "working-tree",
		characterSourceSha256: characterSourceHash(),
		corpusSha256: createHash("sha256").update(readFileSync(corpusPath)).digest("hex"),
		characterId: corpus.characterId,
		providerId: configuredProviderId,
		modelId,
		modelParameters: "Codex session defaults; no per-turn overrides",
		promptSource: corpusPath,
		totalPlannedReplies: corpus.sessions.reduce(
			(total, session) => total + session.prompts.length,
			0,
		),
	};
	const writeSnapshot = () =>
		writeFileSync(
			outputPath,
			`${JSON.stringify(
				{
					metadata,
					sessions: accepted.filter((session) => session !== undefined),
					captureFailures,
				},
				null,
				"\t",
			)}\n`,
		);

	const captureSession = async (index: number): Promise<void> => {
		const session = corpus.sessions[index];
		if (!session) throw new Error(`Missing corpus session ${index}`);
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			let conversationId: string | undefined;
			const turns: CapturedTurn[] = [];
			try {
				const conversation = await rpc<{ conversationId: string }>("conversation.create", {
					title: `角色对抗复测 ${session.label} ${attempt}`,
				});
				conversationId = conversation.conversationId;
				await rpc("model.route.set", {
					conversationId: conversation.conversationId,
					selected: { providerId: configuredProviderId, modelId },
				});
				const open = () =>
					rpc<OpenConversation>("conversation.open", {
						conversationId: conversation.conversationId,
					});
				for (const [turnIndex, prompt] of session.prompts.entries()) {
					const before = projectPiEntries((await open()).branch.entries);
					const beforeIds = new Set(before.map((entry) => entry.id));
					await rpc("message.send", {
						conversationId: conversation.conversationId,
						text: prompt,
						clientMessageId: crypto.randomUUID(),
					});
					let settled: OpenConversation | undefined;
					await expect
						.poll(
							async () => {
								const opened = await open();
								const serialized = JSON.stringify(opened.branch.entries);
								if (serialized.includes('"stopReason":"error"'))
									throw new Error(`Provider error in ${session.label} turn ${turnIndex + 1}`);
								const fresh = projectPiEntries(opened.branch.entries).filter(
									(entry) =>
										!beforeIds.has(entry.id) &&
										entry.type === "message" &&
										entry.role === "assistant" &&
										(entry.text?.trim().length ?? 0) > 0,
								);
								if (!opened.live.isStreaming && fresh.length > 0) settled = opened;
								return settled !== undefined;
							},
							{ timeout: replyTimeout },
						)
						.toBe(true);
					if (!settled) throw new Error(`Turn did not settle: ${session.label} ${turnIndex + 1}`);
					const fresh = projectPiEntries(settled.branch.entries).filter(
						(entry) =>
							!beforeIds.has(entry.id) && entry.type === "message" && entry.role === "assistant",
					);
					const assistant = fresh
						.map((entry) => entry.text?.trim() ?? "")
						.filter(Boolean)
						.join("\n\n");
					if (!assistant)
						throw new Error(`Empty assistant reply: ${session.label} ${turnIndex + 1}`);
					turns.push({
						turn: turnIndex + 1,
						user: prompt,
						assistant,
						assistantEntryIds: fresh.map((entry) => entry.id),
					});
					expect(
						assistant,
						`Visible generation-process text in ${session.label} turn ${turnIndex + 1}`,
					).not.toMatch(/\b(?:We need|Maybe say|User wants)\b|Instead direct|Set repair/i);
					process.stdout.write(
						`[quality] ${session.label} ${turnIndex + 1}/${session.prompts.length}\n`,
					);
				}

				accepted[index] = {
					label: session.label,
					prompts: session.prompts,
					conversationId: conversation.conversationId,
					attempts: attempt,
					turns,
				};
				writeSnapshot();
				return;
			} catch (error) {
				captureFailures.push({
					label: session.label,
					attempt,
					conversationId,
					turns,
					error: error instanceof Error ? error.message : String(error),
				});
				writeSnapshot();
			}
		}
		throw new Error(`Failed to capture a clean session after 3 attempts: ${session.label}`);
	};

	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(4, corpus.sessions.length) }, async () => {
		while (nextIndex < corpus.sessions.length) {
			const index = nextIndex;
			nextIndex += 1;
			await captureSession(index);
		}
	});
	await Promise.all(workers);
	writeSnapshot();
	expect(accepted.every((session) => session !== undefined)).toBe(true);
});
