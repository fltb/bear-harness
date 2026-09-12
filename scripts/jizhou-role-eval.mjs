#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { entriesAfterLeaf } from "./jizhou-role-eval-history.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function hashFile(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}
const hostCwd = resolve(repoRoot, "apps/web-dev");
const hostEntry = resolve(hostCwd, "server/index.ts");
const workerPath = resolve(repoRoot, "packages/host-runtime/dist/executors/pi-acp-worker.js");
const roleRoot = resolve(repoRoot, "config/characters/jizhou");
const casesDefault = resolve(repoRoot, "docs/evidence/jizhou-role-eval-cases.v2.json");
const models = ["gpt-5.6-luna", "gpt-6-astra"];
const providerId = "openai-codex";
const lengths = [6, 6, 6, 8, 8, 8, 8, 8, 14, 30];
const replyTimeoutMs = 180_000;
const startupTimeoutMs = 45_000;
const pollMs = 500;
const authFile =
	process.env.BEAR_WEB_DEV_CODEX_AUTH_FILE || resolve(homedir(), ".codex", "auth.json");
const trackedChildren = new Set();
let stopping = false;

function usage() {
	console.log(`Usage: fnm exec --using=.nvmrc node scripts/jizhou-role-eval.mjs [options]

Options:
  --cases <file>    Frozen v2 cases JSON (default: docs/evidence/jizhou-role-eval-cases.v2.json)
  --out <dir>       Independent result directory (required)
  --repeats <n>     Complete paired repeats (default: 3)
  --mode <mode>     preflight or run (default: run)
  --resume          Reuse completed pairs in --out; retain and replace incomplete attempts
  --help            Show this help

run performs 10 scenarios x 2 models x repeats, with one fresh Host/dataRoot per model.
It writes manifest.json, summary.json, progress.jsonl, and per-session JSON records.`);
}

function parseArgs(argv) {
	const options = { cases: casesDefault, out: "", repeats: 3, mode: "run", resume: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") return { help: true };
		if (arg === "--resume") {
			options.resume = true;
			continue;
		}
		if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
		const key = arg.slice(2);
		if (!(key in options)) throw new Error(`unknown option: --${key}`);
		const value = argv[++i];
		if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
		if (key === "cases") options.cases = resolve(value);
		else if (key === "out") options.out = resolve(value);
		else if (key === "repeats") options.repeats = Number(value);
		else options.mode = value;
	}
	if (!options.out) throw new Error("--out is required");
	if (!Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 20)
		throw new Error("--repeats must be an integer from 1 to 20");
	if (options.mode !== "preflight" && options.mode !== "run")
		throw new Error("--mode must be preflight or run");
	return options;
}

function stableHashFiles(root, label) {
	const hash = createHash("sha256");
	const files = [];
	function walk(current) {
		if (!existsSync(current)) return;
		const info = statSync(current);
		if (info.isFile()) {
			files.push(current);
			return;
		}
		if (!info.isDirectory()) return;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
			walk(join(current, entry.name));
		}
	}
	walk(root);
	files.sort();
	for (const file of files) {
		const name = relative(repoRoot, file).replaceAll("\\", "/");
		hash.update(`${name}\0`);
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return { label, sha256: hash.digest("hex"), files: files.length };
}

function hashInputs(casesPath) {
	return {
		cases: stableHashFiles(casesPath, "cases"),
		role: stableHashFiles(roleRoot, "role"),
		sources: stableHashFiles(resolve(repoRoot, "apps/web-dev/server"), "sources"),
		runtimeSources: stableHashFiles(
			resolve(repoRoot, "packages/host-runtime/src"),
			"host-runtime-sources",
		),
		dist: stableHashFiles(resolve(repoRoot, "packages/host-runtime/dist"), "dist"),
		package: stableHashFiles(resolve(repoRoot, "package.json"), "package"),
		webPackage: stableHashFiles(resolve(repoRoot, "apps/web-dev/package.json"), "web-package"),
		packageLock: stableHashFiles(resolve(repoRoot, "package-lock.json"), "package-lock"),
	};
}

function sameHashes(before, after) {
	return Object.keys(before).every((key) => before[key].sha256 === after[key].sha256);
}

function validateCases(value) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		value.version !== "2" ||
		!Array.isArray(value.scenarios)
	)
		throw new Error("cases must have schema {version:'2', scenarios:[]}");
	if (value.scenarios.length !== 10) throw new Error("cases must contain exactly 10 scenarios");
	for (let index = 0; index < value.scenarios.length; index += 1) {
		const scenario = value.scenarios[index];
		if (!scenario || typeof scenario !== "object" || Array.isArray(scenario))
			throw new Error(`scenario ${index + 1} is invalid`);
		if (
			typeof scenario.id !== "string" ||
			typeof scenario.title !== "string" ||
			typeof scenario.kind !== "string" ||
			!Array.isArray(scenario.turns)
		)
			throw new Error(`scenario ${index + 1} has invalid fields`);
		if (scenario.turns.length !== lengths[index])
			throw new Error(`${scenario.id} must contain ${lengths[index]} turns`);
		for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex += 1) {
			const turn = scenario.turns[turnIndex];
			if (
				!turn ||
				typeof turn !== "object" ||
				typeof turn.id !== "string" ||
				typeof turn.text !== "string" ||
				!Array.isArray(turn.metrics) ||
				turn.metrics.some((metric) => typeof metric !== "string")
			)
				throw new Error(`${scenario.id} turn ${turnIndex + 1} is invalid`);
			const expectedId = `${scenario.id}-T${String(turnIndex + 1).padStart(2, "0")}`;
			if (turn.id !== expectedId) throw new Error(`expected turn id ${expectedId}, got ${turn.id}`);
		}
	}
	return value;
}

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function progress(outDir, event) {
	const record = { at: new Date().toISOString(), ...event };
	writeFileSync(join(outDir, "progress.jsonl"), `${JSON.stringify(record)}\n`, {
		flag: "a",
		mode: 0o600,
	});
	const text =
		event.type === "turn_done"
			? `${event.model} ${event.scenarioId}/${event.turnId} done`
			: event.message || event.type;
	console.log(`[jizhou-eval] ${text}`);
}

function safeReason(error) {
	const text = error instanceof Error ? error.message : String(error);
	return text
		.replaceAll(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [redacted]")
		.replaceAll(
			/(access|refresh|api[_-]?key|token|account[_-]?id)\s*[:=]\s*[^\s,;}]+/giu,
			"$1=[redacted]",
		)
		.slice(0, 300);
}

function isAuthFailure(error) {
	return /auth|credential|unauthori[sz]|401|expired|login|required.*provider/iu.test(
		safeReason(error),
	);
}

async function availablePort() {
	return await new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close((error) => (error ? reject(error) : resolvePort(port)));
		});
	});
}

async function waitForExit(child, timeout = 10_000) {
	if (child.exitCode !== null) return;
	await new Promise((resolveExit) => {
		const timer = setTimeout(resolveExit, timeout);
		child.once("exit", () => {
			clearTimeout(timer);
			resolveExit();
		});
	});
}

async function stopChild(child) {
	if (!child || child.exitCode !== null) {
		if (child) trackedChildren.delete(child);
		return;
	}
	child.kill("SIGTERM");
	await waitForExit(child);
	if (child.exitCode === null) child.kill("SIGKILL");
	await waitForExit(child, 2_000);
	trackedChildren.delete(child);
}

async function cleanupChildren() {
	const children = [...trackedChildren];
	await Promise.all(children.map((child) => stopChild(child)));
}

async function startHost(dataRoot) {
	const port = await availablePort();
	const scope = `jizhou-${process.pid}-${randomUUID()}`;
	mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
	const env = {
		...process.env,
		BEAR_WEB_DEV_HOST_PORT: String(port),
		BEAR_WEB_DEV_DATA_DIR: dataRoot,
		BEAR_WEB_DEV_DATA_SCOPE: scope,
		BEAR_WEB_DEV_DATA_CLEANUP: "never",
		BEAR_WEB_DEV_DEBUG: "0",
		BEAR_WEB_DEV_CODEX_AUTH_FILE: authFile,
		BEAR_WEB_DEV_PI_WORKER_PATH: workerPath,
		BEAR_CUSTOM_PROVIDER_ID: "",
		BEAR_CUSTOM_BASE_URL: "",
		BEAR_CUSTOM_MODEL_ID: "",
		BEAR_CUSTOM_API_KEY: "",
	};
	const child = spawn(process.execPath, [hostEntry], {
		cwd: hostCwd,
		env,
		stdio: ["ignore", "ignore", "ignore"],
	});
	trackedChildren.add(child);
	const deadline = Date.now() + startupTimeoutMs;
	let bootstrap;
	try {
		while (Date.now() < deadline) {
			if (child.exitCode !== null)
				throw new Error(`Host child exited during startup (code ${child.exitCode ?? "signal"})`);
			try {
				const response = await fetch(`http://127.0.0.1:${port}/bootstrap`, {
					signal: AbortSignal.timeout(1_000),
				});
				if (response.ok) {
					bootstrap = await response.json();
					break;
				}
			} catch {
				// The child may still be importing the real Host graph.
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
		}
		if (!bootstrap || typeof bootstrap.token !== "string" || !bootstrap.token)
			throw new Error("Host bootstrap timed out");
		return { child, port, token: bootstrap.token, dataRoot, scope };
	} catch (error) {
		await stopChild(child);
		throw error;
	}
}

async function rpc(host, channel, data = {}, timeout = 30_000) {
	const response = await fetch(`http://127.0.0.1:${host.port}/rpc/${encodeURIComponent(channel)}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-bear-web-dev-token": host.token },
		body: JSON.stringify(data),
		signal: AbortSignal.timeout(timeout),
	});
	let envelope;
	try {
		envelope = await response.json();
	} catch {
		throw new Error(`${channel} returned non-JSON HTTP ${response.status}`);
	}
	if (!response.ok || !envelope?.ok)
		throw new Error(`${channel}: ${envelope?.error?.reason || `HTTP ${response.status}`}`);
	return envelope.data;
}

function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && typeof part === "object" && part.type === "text")
		.map((part) => String(part.text ?? ""))
		.join("\n");
}

function scrubVisible(value, key = "") {
	if (/(access|refresh|api[_-]?key|account[_-]?id|credential|authorization)/iu.test(key))
		return undefined;
	if (/(thinking|reasoning|private[_-]?chain|chain[_-]?of[_-]?thought)/iu.test(key))
		return undefined;
	if (Array.isArray(value))
		return value.map((item) => scrubVisible(item)).filter((item) => item !== undefined);
	if (!value || typeof value !== "object") return value;
	const result = {};
	for (const [childKey, childValue] of Object.entries(value)) {
		if (/^(thinking|reasoning|private|chainOfThought)$/iu.test(childKey)) continue;
		if (childKey === "content" && Array.isArray(childValue)) {
			result[childKey] = childValue
				.filter(
					(part) =>
						!(
							part &&
							typeof part === "object" &&
							/^(thinking|reasoning)$/iu.test(String(part.type))
						),
				)
				.map((part) => scrubVisible(part))
				.filter((part) => part !== undefined);
			continue;
		}
		const cleaned = scrubVisible(childValue, childKey);
		if (cleaned !== undefined) result[childKey] = cleaned;
	}
	return result;
}

function entries(snapshot) {
	return Array.isArray(snapshot?.branch?.entries) ? snapshot.branch.entries : [];
}

function entryMessage(entry) {
	return entry && typeof entry === "object" && entry.message && typeof entry.message === "object"
		? entry.message
		: null;
}

function visibleMessages(rawEntries) {
	return rawEntries
		.filter((entry) => entry && typeof entry === "object" && entry.type === "message")
		.map((entry) => {
			const message = entryMessage(entry);
			return {
				id: typeof entry.id === "string" ? entry.id : undefined,
				role: typeof message?.role === "string" ? message.role : undefined,
				text: contentText(message?.content),
				toolName: typeof message?.toolName === "string" ? message.toolName : undefined,
				providerId: typeof message?.provider === "string" ? message.provider : undefined,
				modelId: typeof message?.model === "string" ? message.model : undefined,
				stopReason: typeof message?.stopReason === "string" ? message.stopReason : undefined,
				usage:
					message?.usage && typeof message.usage === "object"
						? scrubVisible(message.usage)
						: undefined,
				entry: scrubVisible(entry),
			};
		});
}

function lastError(rawEntries) {
	for (let i = rawEntries.length - 1; i >= 0; i -= 1) {
		const message = entryMessage(rawEntries[i]);
		if (message?.stopReason === "error") return scrubVisible(rawEntries[i]);
	}
	return undefined;
}

function hasMediumThinking(rawEntries) {
	return rawEntries.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		if (entry.type === "thinking_level_change" && entry.thinkingLevel === "medium") return true;
		const message = entryMessage(entry);
		return (
			message?.type === "thinking_level_change" &&
			(message.thinkingLevel === "medium" || message.level === "medium")
		);
	});
}

async function setupHost(host, modelId) {
	const listed = await rpc(host, "provider.list", {});
	const provider = listed?.providers?.find((item) => item?.id === providerId);
	const metadataModel = provider?.availableModels?.find((item) => item?.id === modelId);
	if (!provider) throw new Error(`provider metadata missing: ${providerId}`);
	if (!metadataModel) throw new Error(`model metadata missing: ${modelId}`);
	if (
		provider.credentialStatus === "missing" ||
		provider.credentialStatus === "invalid" ||
		provider.credentialStatus === "unavailable"
	)
		throw new Error(`provider credential unavailable: ${provider.credentialStatus}`);
	await rpc(host, "model.enable", { providerId, modelId, label: `极昼评测 ${modelId}` });
	await rpc(host, "systemOnboarding.completeModel", {
		reply: { providerId, modelId },
		vision: { mode: "auto" },
		licensesAcknowledged: {
			bear: "GPL-3.0-only",
			...(process.platform === "win32" ? { gitForWindows: "GPL-2.0-only" } : {}),
		},
	});
	await rpc(host, "systemOnboarding.completeEmbedding", { choice: "none" });
	await rpc(host, "model.defaults.completeOnboarding", {});
	let onboarding = await rpc(host, "onboarding.get", {});
	const answers = { welcome: undefined, nickname: "林" };
	while (onboarding?.status === "active") {
		const stepId = onboarding.currentStepId;
		if (!(stepId in answers)) throw new Error(`unhandled onboarding step: ${String(stepId)}`);
		onboarding = await rpc(host, "onboarding.submit", { stepId, answer: answers[stepId] });
	}
	const defaults = await rpc(host, "model.defaults.get", {});
	if (defaults?.reply?.providerId !== providerId || defaults?.reply?.modelId !== modelId)
		throw new Error("default route did not select requested model");
	return {
		provider: {
			id: provider.id,
			credentialStatus: provider.credentialStatus,
			model: metadataModel,
		},
		defaults,
		onboarding,
	};
}

async function createConversation(host, modelId, title) {
	const conversation = await rpc(host, "conversation.create", { title });
	await rpc(host, "model.route.set", {
		conversationId: conversation.conversationId,
		selected: { providerId, modelId },
	});
	const opened = await rpc(host, "conversation.open", {
		conversationId: conversation.conversationId,
	});
	if (
		opened?.selectedModel?.providerId !== providerId ||
		opened?.selectedModel?.modelId !== modelId
	)
		throw new Error("actual provider/model route mismatch");
	if (!hasMediumThinking(entries(opened)))
		throw new Error("Initial native thinking level is not medium");
	return {
		id: conversation.conversationId,
		initial: scrubVisible(opened),
		selectedModel: opened.selectedModel,
		initialLeafId: opened.branch.activeLeafId,
	};
}

async function captureInitialRuntime(host, conversation, setupState) {
	const snapshot = await rpc(host, "snapshot.get", {});
	const characterId = snapshot?.character?.id;
	if (characterId !== "jizhou")
		throw new Error(`active character is not jizhou: ${String(characterId)}`);
	const loadedPackage = await rpc(host, "character.packageGet", { characterId });
	const sourceYamlHash = hashFile(join(roleRoot, "character.yaml"));
	if (loadedPackage?.package?.sha256 !== sourceYamlHash)
		throw new Error("loaded character.yaml hash differs from frozen source");
	const canonList = await rpc(host, "canon.listSources", { limit: 100 });
	const sourceCanonFiles = readdirSync(resolve(roleRoot, "canon"), { withFileTypes: true }).filter(
		(entry) => entry.isFile() && entry.name.endsWith(".md"),
	);
	const scopedRoot = join(host.dataRoot, `.process-${host.scope}`);
	const canonHashes = sourceCanonFiles.map((entry) => {
		const sourcePath = join(roleRoot, "canon", entry.name);
		const sha256 = hashFile(sourcePath);
		const installedPath = join(scopedRoot, "characters", characterId, "canon", entry.name);
		if (hashFile(installedPath) !== sha256)
			throw new Error(`installed Canon bytes differ for ${entry.name}`);
		// CanonService indexes normalized text and names it by manifest title, not filename.
		const indexedSha256 = createHash("sha256")
			.update(readFileSync(sourcePath, "utf8").replaceAll("\r\n", "\n").trim())
			.digest("hex");
		const indexed = canonList.sources.find(
			(source) => source.origin === "package" && source.sha256 === indexedSha256,
		);
		if (!indexed) throw new Error(`indexed Canon content differs for ${entry.name}`);
		return { path: entry.name, sha256, indexedSha256, logicalName: indexed.logicalName };
	});
	const companionState = await rpc(host, "companionState.get", { conversationId: conversation.id });
	const memoryPath = join(scopedRoot, "companions", characterId, "memory", "MEMORY.md");
	const memoryText = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
	if (memoryText.trim()) throw new Error("fresh session MEMORY.md is not empty");
	const memorySha256 = createHash("sha256").update(memoryText).digest("hex");
	return {
		...setupState,
		snapshot: scrubVisible(snapshot),
		companionState: scrubVisible(companionState),
		memory: { path: "companions/jizhou/memory/MEMORY.md", sha256: memorySha256, empty: true },
		loadedRole: {
			characterYamlSha256: loadedPackage.package.sha256,
			canon: canonHashes,
			packageManifest: scrubVisible(loadedPackage.package.manifest),
		},
	};
}

function readTurnEntries(host, conversationId, snapshot, beforeLeafId) {
	return entriesAfterLeaf(snapshot, beforeLeafId, (beforeEntryId) =>
		rpc(host, "conversation.history", { conversationId, beforeEntryId, limit: 100 }),
	);
}

async function waitSettled(
	host,
	conversationId,
	beforeLeafId,
	expectedUserText,
	expectedProviderId,
	expectedModelId,
	deadline,
) {
	const liveObservations = [];
	while (Date.now() < deadline) {
		const snapshot = await rpc(host, "conversation.open", { conversationId });
		liveObservations.push({
			at: new Date().toISOString(),
			isStreaming: snapshot?.live?.isStreaming,
			isRetrying: snapshot?.live?.isRetrying,
			retryAttempt: snapshot?.live?.retryAttempt,
			isCompacting: snapshot?.live?.isCompacting,
			error:
				typeof snapshot?.live?.errorMessage === "string"
					? safeReason(new Error(snapshot.live.errorMessage))
					: undefined,
		});
		const turnEntries = await readTurnEntries(host, conversationId, snapshot, beforeLeafId);
		const messages = visibleMessages(turnEntries);
		const hasExpectedUser = messages.some(
			(message) => message.role === "user" && message.text === expectedUserText,
		);
		const assistantMessages = messages.filter((message) => message.role === "assistant");
		const latestAssistant = assistantMessages.at(-1);
		const isSettled =
			snapshot?.live?.isStreaming === false &&
			snapshot?.live?.isRetrying === false &&
			snapshot?.live?.isCompacting === false;
		if (isSettled && ["error", "aborted"].includes(latestAssistant?.stopReason)) {
			const detail = latestAssistant.entry?.message?.errorMessage;
			throw new Error(
				`native model stopReason=${latestAssistant.stopReason}${detail ? `: ${safeReason(new Error(detail))}` : ""}`,
			);
		}
		const hasActualModel =
			latestAssistant?.providerId === expectedProviderId &&
			latestAssistant?.modelId === expectedModelId;
		const hasTerminalAssistant =
			typeof latestAssistant?.stopReason === "string" &&
			["stop", "length"].includes(latestAssistant.stopReason);
		if (isSettled && hasExpectedUser && hasTerminalAssistant) {
			if (!hasActualModel) throw new Error("assistant provider/model differs from requested route");
			return { turnEntries, liveObservations };
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
	}
	throw new Error(
		"model turn timed out while waiting for native settled user/assistant terminal snapshot",
	);
}

function appendPartialTurn(record, host, conversationId, turnId, user, beforeLeafId) {
	return rpc(host, "conversation.open", { conversationId })
		.then(async (snapshot) => {
			const raw = await readTurnEntries(host, conversationId, snapshot, beforeLeafId);
			const messages = visibleMessages(raw);
			record.turns.push({
				turnId,
				user,
				partial: true,
				stopReason: messages.findLast((message) => message.role === "assistant")?.stopReason,
				nativeError: scrubVisible(lastError(raw)),
				live: scrubVisible(snapshot?.live),
				visibleMessages: messages,
				rawVisibleEntries: raw.map((entry) => scrubVisible(entry)),
			});
		})
		.catch(() => undefined);
}
async function abortConversation(host, conversationId) {
	try {
		await rpc(host, "message.abort", { conversationId }, 10_000);
	} catch {
		// Preserve timeout as the technical failure; shutdown still kills the exact Host child.
	}
}

async function runSession({
	host,
	modelId,
	scenario,
	repeat,
	attempt,
	outDir,
	frozenHashes,
	preflight = false,
}) {
	const record = {
		schemaVersion: "jizhou-role-eval-session.v1",
		collectorRevision: 2,
		mode: preflight ? "preflight" : "run",
		model: { providerId, modelId },
		scenarioId: scenario?.id,
		repeat,
		attempt,
		startedAt: new Date().toISOString(),
		timeoutMs: replyTimeoutMs,
		initialState: null,
		turns: [],
		technicalFailure: null,
	};
	const path = preflight
		? join(outDir, `preflight-${modelId}.json`)
		: join(outDir, "sessions", modelId, scenario.id, `repeat-${repeat}-attempt-${attempt}.json`);
	try {
		const state = await setupHost(host, modelId);
		const conversation = await createConversation(
			host,
			modelId,
			preflight ? `极昼预检 ${modelId}` : `极昼评测 ${scenario.id} R${repeat} A${attempt}`,
		);
		record.initialState = await captureInitialRuntime(host, conversation, state);
		record.status = "running";
		writeJson(path, record);
		if (preflight) {
			const beforeLeafId = conversation.initialLeafId;
			const started = Date.now();
			const text = "你好，只回复预检通过。";
			await rpc(host, "message.send", {
				conversationId: conversation.id,
				text,
				clientMessageId: randomUUID(),
			});
			let raw;
			let liveObservations;
			try {
				({ turnEntries: raw, liveObservations } = await waitSettled(
					host,
					conversation.id,
					beforeLeafId,
					text,
					providerId,
					modelId,
					Date.now() + replyTimeoutMs,
				));
			} catch (error) {
				await appendPartialTurn(record, host, conversation.id, "PREFLIGHT", text, beforeLeafId);
				await abortConversation(host, conversation.id);
				throw error;
			}
			const preflightMessages = visibleMessages(raw);
			const preflightAssistant = preflightMessages.findLast(
				(message) => message.role === "assistant",
			);
			record.turns.push({
				turnId: "PREFLIGHT",
				user: text,
				elapsedMs: Date.now() - started,
				stopReason: preflightAssistant?.stopReason,
				usage: preflightAssistant?.usage,
				visibleMessages: preflightMessages,
				rawVisibleEntries: raw.map((entry) => scrubVisible(entry)),
				liveObservations,
				thinkingLevelChange: "medium",
			});
		} else {
			for (const turn of scenario.turns) {
				if (!sameHashes(frozenHashes, hashInputs(frozenHashes.cases.path)))
					throw new Error("frozen input changed during run");
				const beforeSnapshot = await rpc(host, "conversation.open", {
					conversationId: conversation.id,
				});
				const beforeLeafId = beforeSnapshot.branch.activeLeafId;
				const started = Date.now();
				await rpc(host, "message.send", {
					conversationId: conversation.id,
					text: turn.text,
					clientMessageId: randomUUID(),
				});
				let rawTurn;
				let liveObservations;
				try {
					({ turnEntries: rawTurn, liveObservations } = await waitSettled(
						host,
						conversation.id,
						beforeLeafId,
						turn.text,
						providerId,
						modelId,
						Date.now() + replyTimeoutMs,
					));
				} catch (error) {
					await appendPartialTurn(record, host, conversation.id, turn.id, turn.text, beforeLeafId);
					await abortConversation(host, conversation.id);
					throw error;
				}
				const messages = visibleMessages(rawTurn);
				if (
					rawTurn.some(
						(entry) => entry.type === "thinking_level_change" && entry.thinkingLevel !== "medium",
					)
				)
					throw new Error("Native thinking level changed away from medium");
				const assistant = messages.findLast((message) => message.role === "assistant");
				record.turns.push({
					turnId: turn.id,
					metrics: turn.metrics,
					user: turn.text,
					elapsedMs: Date.now() - started,
					stopReason: assistant?.stopReason,
					usage: assistant?.usage,
					visibleMessages: messages,
					rawVisibleEntries: rawTurn.map((entry) => scrubVisible(entry)),
					liveObservations,
					thinkingLevelChange: "medium",
				});
				writeJson(path, record);
				progress(outDir, {
					type: "turn_done",
					model: modelId,
					scenarioId: scenario.id,
					turnId: turn.id,
					repeat,
					attempt,
				});
			}
		}
		record.status = "passed";
	} catch (error) {
		record.status = "failed";
		record.technicalFailure = { reason: safeReason(error), authFailure: isAuthFailure(error) };
		if (isAuthFailure(error)) record.abortReason = "auth_failure_not_retried";
	}
	record.finishedAt = new Date().toISOString();
	record.elapsedMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
	writeJson(path, record);
	return record;
}
function startupFailureRecord({ modelId, scenario, repeat, attempt, error, outDir }) {
	const startedAt = new Date().toISOString();
	const record = {
		schemaVersion: "jizhou-role-eval-session.v1",
		mode: "run",
		model: { providerId, modelId },
		scenarioId: scenario.id,
		repeat,
		attempt,
		startedAt,
		finishedAt: startedAt,
		elapsedMs: 0,
		timeoutMs: replyTimeoutMs,
		turns: [],
		status: "failed",
		technicalFailure: { reason: safeReason(error), authFailure: isAuthFailure(error) },
	};
	writeJson(
		join(outDir, "sessions", modelId, scenario.id, `repeat-${repeat}-attempt-${attempt}.json`),
		record,
	);
	return record;
}

async function runOnePair({ scenario, repeat, attempt, outDir, frozenHashes, firstModel }) {
	const order = firstModel === models[0] ? models : [models[1], models[0]];
	const hosts = new Map();
	const roots = new Set();
	try {
		for (const modelId of order) {
			const root = mkdtempSync(join(tmpdir(), `bear-jizhou-${modelId}-`), { encoding: "utf8" });
			roots.add(root);
			hosts.set(modelId, await startHost(root));
		}
		const records = await Promise.all(
			models.map((modelId) =>
				runSession({
					host: hosts.get(modelId),
					modelId,
					scenario,
					repeat,
					attempt,
					outDir,
					frozenHashes,
				}),
			),
		);
		const failed = records.filter((record) => record.status !== "passed");
		return { records, failed };
	} catch (error) {
		const records = models.map((modelId) =>
			startupFailureRecord({ modelId, scenario, repeat, attempt, error, outDir }),
		);
		return { records, failed: records };
	} finally {
		for (const host of hosts.values()) await stopChild(host.child);
		for (const host of hosts.values()) roots.add(host.dataRoot);
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	}
}

async function preflight(outDir, frozenHashes) {
	const records = [];
	await Promise.all(
		models.map(async (modelId) => {
			const root = mkdtempSync(join(tmpdir(), `bear-jizhou-preflight-${modelId}-`));
			let host;
			try {
				host = await startHost(root);
				records.push(
					await runSession({
						host,
						modelId,
						repeat: 0,
						attempt: 1,
						outDir,
						frozenHashes,
						preflight: true,
					}),
				);
			} catch (error) {
				const startedAt = new Date().toISOString();
				const record = {
					schemaVersion: "jizhou-role-eval-session.v1",
					mode: "preflight",
					model: { providerId, modelId },
					repeat: 0,
					attempt: 1,
					startedAt,
					finishedAt: startedAt,
					elapsedMs: 0,
					turns: [],
					status: "failed",
					technicalFailure: { reason: safeReason(error), authFailure: isAuthFailure(error) },
				};
				writeJson(join(outDir, `preflight-${modelId}.json`), record);
				records.push(record);
			} finally {
				if (host) await stopChild(host.child);
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
	return records;
}

function existingPair(outDir, scenario, repeat) {
	const records = [];
	for (const modelId of models) {
		const directory = join(outDir, "sessions", modelId, scenario.id);
		if (!existsSync(directory)) continue;
		for (const name of readdirSync(directory)) {
			if (!new RegExp(`^repeat-${repeat}-attempt-\\d+\\.json$`).test(name)) continue;
			const path = join(directory, name);
			const record = JSON.parse(readFileSync(path, "utf8"));
			if (
				record.model.modelId !== modelId ||
				record.scenarioId !== scenario.id ||
				record.repeat !== repeat
			)
				throw new Error(`Mismatched checkpoint: ${path}`);
			records.push({
				path: relative(outDir, path),
				modelId,
				attempt: record.attempt,
				status: record.status,
				turns: record.turns.length,
				reason: record.technicalFailure?.reason,
			});
		}
	}
	const lastAttempt = Math.max(0, ...records.map((record) => record.attempt));
	const latest = records.filter((record) => record.attempt === lastAttempt);
	return {
		nextAttempt: lastAttempt + 1,
		complete:
			latest.length === 2 &&
			latest.every(
				(record) => record.status === "passed" && record.turns === scenario.turns.length,
			),
		records,
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return 0;
	}
	if (!existsSync(options.cases)) throw new Error(`cases file not found: ${options.cases}`);
	if (!existsSync(authFile)) throw new Error(`Codex auth file not found: ${authFile}`);
	const cases = validateCases(JSON.parse(readFileSync(options.cases, "utf8")));
	const initialHashes = hashInputs(options.cases);
	initialHashes.cases.path = options.cases;
	mkdirSync(options.out, { recursive: true, mode: 0o700 });
	const manifestPath = join(options.out, "manifest.json");
	const previousManifest = existsSync(manifestPath)
		? JSON.parse(readFileSync(manifestPath, "utf8"))
		: null;
	if (previousManifest && !options.resume)
		throw new Error("out directory already contains manifest.json; refusing overwrite");
	if (
		options.resume &&
		(!previousManifest ||
			options.mode !== "run" ||
			previousManifest.mode !== "run" ||
			previousManifest.repeats !== options.repeats ||
			!sameHashes(previousManifest.hashes, initialHashes))
	)
		throw new Error("Resume requires a run manifest with identical frozen inputs and repeat count");
	const collector = {
		revision: 2,
		scriptSha256: hashFile(fileURLToPath(import.meta.url)),
		historySha256: hashFile(resolve(repoRoot, "scripts/jizhou-role-eval-history.mjs")),
	};
	const manifest = previousManifest ?? {
		schemaVersion: "jizhou-role-eval-manifest.v1",
		mode: options.mode,
		models: models.map((modelId) => ({ providerId, modelId })),
		repeats: options.mode === "run" ? options.repeats : 1,
		collector,
		replyTimeoutMs,
		auth: {
			providerId,
			source: "BEAR_WEB_DEV_CODEX_AUTH_FILE via WebDev credential bridge",
			path: "redacted",
		},
		hashes: initialHashes,
		cases: {
			path: relative(repoRoot, options.cases),
			version: cases.version,
			scenarioCount: cases.scenarios.length,
			totalTurns: cases.scenarios.reduce((sum, scenario) => sum + scenario.turns.length, 0),
		},
		environment: {
			node: process.version,
			platform: process.platform,
			cwd: process.cwd(),
			hostCwd,
			workerPath: relative(repoRoot, workerPath),
			noUi: true,
			dataIsolation: "fresh mkdtemp per model/session",
			maxConcurrentPairSessions: 2,
			thinkingLevel: "medium required",
			memoryEmbedding: "none",
		},
		startedAt: new Date().toISOString(),
	};
	if (options.resume)
		manifest.resumes = [...(manifest.resumes ?? []), { at: new Date().toISOString(), collector }];
	writeJson(manifestPath, manifest);
	progress(options.out, {
		type: options.resume ? "resumed" : "started",
		mode: options.mode,
		message: `${options.resume ? "resuming" : "starting"} ${options.mode}`,
	});
	if (options.mode === "preflight") {
		const records = await preflight(options.out, initialHashes);
		if (!sameHashes(initialHashes, hashInputs(options.cases)))
			throw new Error("frozen input changed during preflight");
		const summary = {
			schemaVersion: "jizhou-role-eval-summary.v1",
			mode: "preflight",
			completeRounds: records.filter((record) => record.status === "passed").length,
			failedRounds: records.filter((record) => record.status !== "passed").length,
			reruns: 0,
			records: records.map((record) => ({
				model: record.model,
				status: record.status,
				technicalFailure: record.technicalFailure,
			})),
		};
		writeJson(join(options.out, "summary.json"), summary);
		return summary.failedRounds === 0 ? 0 : 1;
	}
	const summary = {
		schemaVersion: "jizhou-role-eval-summary.v1",
		mode: "run",
		plannedPairs: options.repeats * cases.scenarios.length,
		completeRounds: 0,
		failedRounds: 0,
		reruns: 0,
		reusedPairs: 0,
		priorAttempts: [],
		originalFailures: 0,
		technicalFailures: [],
		authFailure: false,
	};
	for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
		for (let scenarioIndex = 0; scenarioIndex < cases.scenarios.length; scenarioIndex += 1) {
			const scenario = cases.scenarios[scenarioIndex];
			if (!sameHashes(initialHashes, hashInputs(options.cases)))
				throw new Error("frozen input changed before next paired scenario");
			const previous = options.resume
				? existingPair(options.out, scenario, repeat)
				: { nextAttempt: 1, complete: false, records: [] };
			if (previous.complete) {
				summary.completeRounds += 2;
				summary.reusedPairs += 1;
				writeJson(join(options.out, "summary.json"), summary);
				continue;
			}
			summary.priorAttempts.push(...previous.records);
			const firstAttempt = previous.nextAttempt;
			const firstModel = (repeat + scenarioIndex) % 2 === 0 ? models[0] : models[1];
			progress(options.out, {
				type: "pair_start",
				scenarioId: scenario.id,
				repeat,
				attempt: firstAttempt,
				message: `${scenario.id} repeat ${repeat} starting`,
			});
			let pair = await runOnePair({
				scenario,
				repeat,
				attempt: firstAttempt,
				outDir: options.out,
				frozenHashes: initialHashes,
				firstModel,
			});
			if (pair.failed.length > 0) {
				summary.originalFailures += pair.failed.length;
				summary.failedRounds += pair.failed.length;
				summary.technicalFailures.push(
					...pair.failed.map((record) => ({
						model: record.model,
						scenarioId: scenario.id,
						repeat,
						attempt: firstAttempt,
						reason: record.technicalFailure?.reason,
					})),
				);
				if (pair.failed.some((record) => record.technicalFailure?.authFailure)) {
					summary.authFailure = true;
					writeJson(join(options.out, "summary.json"), summary);
					return 1;
				}
				progress(options.out, {
					type: "pair_rerun",
					scenarioId: scenario.id,
					repeat,
					attempt: firstAttempt + 1,
					message: `${scenario.id} repeat ${repeat} technical failure; rerunning complete pair`,
				});
				summary.reruns += 1;
				pair = await runOnePair({
					scenario,
					repeat,
					attempt: firstAttempt + 1,
					outDir: options.out,
					frozenHashes: initialHashes,
					firstModel,
				});
				if (pair.failed.length > 0) {
					summary.failedRounds += pair.failed.length;
					summary.technicalFailures.push(
						...pair.failed.map((record) => ({
							model: record.model,
							scenarioId: scenario.id,
							repeat,
							attempt: firstAttempt + 1,
							reason: record.technicalFailure?.reason,
						})),
					);
					if (pair.failed.some((record) => record.technicalFailure?.authFailure)) {
						summary.authFailure = true;
						writeJson(join(options.out, "summary.json"), summary);
						return 1;
					}
				} else {
					summary.completeRounds += 2;
				}
			} else {
				summary.completeRounds += 2;
			}
			writeJson(join(options.out, "summary.json"), summary);
		}
	}
	summary.finishedAt = new Date().toISOString();
	writeJson(join(options.out, "summary.json"), summary);
	progress(options.out, {
		type: "finished",
		message: `complete rounds ${summary.completeRounds}, failed ${summary.failedRounds}, reruns ${summary.reruns}`,
	});
	return summary.failedRounds === 0 ? 0 : 1;
}

process.once("SIGINT", () => {
	if (stopping) return;
	stopping = true;
	void cleanupChildren().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
	if (stopping) return;
	stopping = true;
	void cleanupChildren().finally(() => process.exit(143));
});

try {
	const code = await main();
	await cleanupChildren();
	process.exitCode = code;
} catch (error) {
	await cleanupChildren();
	console.error(`[jizhou-eval] failed: ${safeReason(error)}`);
	process.exitCode = 1;
}
