// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import { drizzle } from "drizzle-orm/node-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CompanionModelRuntimeSource,
	CompanionSupervisor,
	extractLatestAssistantText,
} from "../src/companion/supervisor.js";
import { EventBus } from "../src/storage/event-bus.js";

const temporaryDirectories: string[] = [];

async function settleRuntime(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitForSession(runtime: CompanionSupervisor) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const session = Reflect.get(runtime, "session");
		if (session) return session;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Companion Pi session did not initialize");
}

describe("in-process Companion Host bridge", () => {
	it("extracts the latest assistant text even when a non-message entry follows it", () => {
		expect(
			extractLatestAssistantText([
				{ role: "user", content: [{ type: "text", text: "question" }] },
				{ role: "assistant", content: [{ type: "text", text: "observation" }] },
				{ role: "toolResult", content: [] },
			]),
		).toBe("observation");
	});

	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
		Reflect.deleteProperty(globalThis, "bearHostCall");
		Reflect.deleteProperty(globalThis, "bearPiType");
	});

	it("routes a role plugin Host request directly to the allowlisted Host handler", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-in-process-runtime-"));
		temporaryDirectories.push(root);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: join(root, "models.json"),
			refreshOnCreate: false,
		});
		const providers: CompanionModelRuntimeSource = {
			getModels: async () => modelRuntime,
		};
		const db = new DatabaseSync(":memory:");
		db.exec(
			"CREATE TABLE events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
		);
		const eventBus = new EventBus(drizzle({ client: db }));
		const events: Array<{ kind: string; payload: unknown }> = [];
		eventBus.subscribe((event) => events.push(event));
		const runtime = new CompanionSupervisor(root, eventBus, providers);
		const hostCalls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
		runtime.setHostToolHandler((call) => {
			hostCalls.push(call);
			return { ok: true, message: "Host state updated." };
		});
		await runtime.start();
		expect(runtime.isRunning).toBe(true);

		// A prompt establishes the turn scope before the model/auth gate reports
		// its expected no-credential state. Role plugins call this same global.
		runtime.sendCommand({
			type: "prompt",
			conversationId: "conversation-1",
			message: "切换到雪原",
		});
		await settleRuntime();
		const hostCall = Reflect.get(globalThis, "bearHostCall");
		if (typeof hostCall !== "function") throw new Error("Host bridge was not injected");
		const result = await hostCall("host_set_scene", { sceneId: "snow_plains" });

		expect(result).toMatchObject({ ok: true });
		expect(hostCalls).toEqual([
			{
				conversationId: "conversation-1",
				tool: "host_set_scene",
				args: { sceneId: "snow_plains" },
			},
		]);
		await runtime.stop();
		db.close();
	});

	it("compiles the role prompt and exposes only its controlled tools", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-in-process-prompt-"));
		temporaryDirectories.push(root);
		const skills = join(root, "skills");
		mkdirSync(join(skills, "station-log"), { recursive: true });
		writeFileSync(
			join(skills, "station-log", "SKILL.md"),
			"---\nname: station-log\ndescription: Inspect the station log.\n---\nRead the role-owned station log.\n",
		);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: join(root, "models.json"),
			refreshOnCreate: false,
		});
		const providers: CompanionModelRuntimeSource = {
			getModels: async () => modelRuntime,
		};
		const db = new DatabaseSync(":memory:");
		db.exec(
			"CREATE TABLE events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
		);
		const runtime = new CompanionSupervisor(root, new EventBus(drizzle({ client: db })), providers);
		runtime.configureRuntime({
			skillPaths: [skills],
			pluginPaths: [],
			appendSystemPrompt: "IDENTITY_SENTINEL\nSTYLE_SENTINEL",
			hostTools: [
				"host_get_state",
				"host_set_scene",
				"host_set_expression",
				"host_search_canon",
			],
		});
		const hostCalls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
		runtime.setHostToolHandler((call) => {
			hostCalls.push(call);
			return { ok: true, message: "Host state updated." };
		});
		await runtime.start();
		runtime.sendCommand({
			type: "prompt",
			conversationId: "conversation-2",
			message: "查看站点记录",
		});
		const session = await waitForSession(runtime);

		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining([
				"read",
				"host_get_state",
				"host_set_scene",
				"host_set_expression",
				"host_search_canon",
			]),
		);
		expect(session.getActiveToolNames()).not.toEqual(
			expect.arrayContaining(["host_play_media", "host_present_choices", "host_propose_work"]),
		);
		expect(session.getActiveToolNames()).not.toEqual(
			expect.arrayContaining(["bash", "edit", "write"]),
		);
		const runtimeReady = db
			.prepare(
				"SELECT payload FROM events WHERE kind = 'companion.runtime_ready' ORDER BY seq DESC LIMIT 1",
			)
			.get() as { payload: string } | undefined;
		expect(JSON.parse(runtimeReady?.payload ?? "{}")).toMatchObject({ skills: ["station-log"] });
		expect(session.systemPrompt).toContain("IDENTITY_SENTINEL");
		expect(session.systemPrompt).toContain("STYLE_SENTINEL");
		expect(session.systemPrompt).toContain("station-log");

		const sceneTool = session.getToolDefinition("host_set_scene");
		expect(sceneTool).toBeDefined();
		if (!sceneTool) throw new Error("host_set_scene was not registered");
		const toolResult = await Reflect.apply(sceneTool.execute, sceneTool, [
			"tool-call-1",
			{ sceneId: "snow_plains" },
		]);
		expect(toolResult).toMatchObject({ details: { ok: true } });
		const canonTool = session.getToolDefinition("host_search_canon");
		expect(canonTool).toBeDefined();
		if (!canonTool) throw new Error("host_search_canon was not registered");
		await Reflect.apply(canonTool.execute, canonTool, ["tool-call-2", { query: "旧极光站" }]);
		expect(hostCalls).toEqual([
			{
				conversationId: "conversation-2",
				tool: "host_set_scene",
				args: { sceneId: "snow_plains" },
			},
			{
				conversationId: "conversation-2",
				tool: "host_search_canon",
				args: { query: "旧极光站" },
			},
		]);
		await runtime.stop();
		db.close();
	});
	it("awaits an async context handler before assembling the final prompt", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-in-process-async-context-"));
		temporaryDirectories.push(root);
		const faux = fauxProvider({
			provider: "test-provider",
			models: [{ id: "test-model", name: "Test model" }],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		let assembledPrompt: string | undefined;
		faux.setResponses([
			(context) => {
				const userMessage = context.messages.at(-1);
				if (userMessage?.role === "user") {
					assembledPrompt =
						typeof userMessage.content === "string"
							? userMessage.content
							: userMessage.content
									.map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
									.join("");
				}
				return fauxAssistantMessage("reply");
			},
		]);
		const providers: CompanionModelRuntimeSource = {
			getModels: async () => models,
		};
		const db = new DatabaseSync(":memory:");
		db.exec(
			"CREATE TABLE events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
		);
		const eventBus = new EventBus(drizzle({ client: db }));
		const runtime = new CompanionSupervisor(root, eventBus, providers);
		runtime.setContextHandler(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			return "ASYNC_CONTEXT_SENTINEL";
		});
		await runtime.start();
		const completed = new Promise<void>((resolve) => {
			const unsubscribe = eventBus.subscribe((event) => {
				if (event.kind !== "message_end") return;
				unsubscribe();
				resolve();
			});
		});
		runtime.sendCommand({
			type: "prompt",
			conversationId: "conversation-async-context",
			message: "current user message",
		});
		await completed;

		expect(assembledPrompt).toBe(
			"<host_context>\nASYNC_CONTEXT_SENTINEL\n</host_context>\n\n<current_user_message>\ncurrent user message\n</current_user_message>",
		);
		await runtime.stop();
		db.close();
	});
});
