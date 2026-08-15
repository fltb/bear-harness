/**
 * Sandbox preload for the Cyber Bear shell.
 *
 * Only `contextBridge` and `ipcRenderer` are imported. This single file
 * validates the renderer-fault envelope in the isolated world and attaches
 * the launch traceparent from `--bear-traceparent=<value>` (read from
 * `process.argv`, never exposed to the page).
 *
 * The preload must not depend on local or third-party modules: sandboxed
 * preloads only `require("electron")`.
 */

import { contextBridge, ipcRenderer } from "electron";

type ErrorType =
	| "Error"
	| "TypeError"
	| "RangeError"
	| "ReferenceError"
	| "SyntaxError"
	| "AggregateError"
	| "DOMException"
	| "non-error"
	| "unknown";

interface FaultInput {
	kind: "error" | "unhandled-rejection";
	errorType: ErrorType;
	line?: number;
	column?: number;
}

const TRACEPARENT_ARG_PREFIX = "--bear-traceparent=";
const traceparent: string =
	process.argv
		.find((arg) => arg.startsWith(TRACEPARENT_ARG_PREFIX))
		?.slice(TRACEPARENT_ARG_PREFIX.length) ?? "";

const FAULT_KEYS = ["kind", "errorType", "line", "column"] as const;
const ERROR_TYPES: readonly ErrorType[] = [
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"AggregateError",
	"DOMException",
	"non-error",
	"unknown",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
	);
}

/** Exact-shape validation: only known keys, valid kind/errorType, finite line/column. */
function validFault(input: unknown): input is FaultInput {
	if (!isPlainObject(input)) return false;
	for (const key of Object.keys(input)) {
		if (!(FAULT_KEYS as readonly string[]).includes(key)) return false;
	}
	if (input.kind !== "error" && input.kind !== "unhandled-rejection") return false;
	if (
		typeof input.errorType !== "string" ||
		!(ERROR_TYPES as readonly string[]).includes(input.errorType)
	) {
		return false;
	}
	for (const key of ["line", "column"]) {
		if (key in input) {
			const value = input[key];
			if (
				typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value < 0 ||
				value > 2_147_483_647
			) {
				return false;
			}
		}
	}
	return true;
}

function reportRendererFault(input: unknown): void {
	if (!validFault(input)) return;
	ipcRenderer.send("diagnostics:renderer-fault:v1", { traceparent, fault: input });
}

const companionFacade = Object.freeze({
	snapshot: Object.freeze({
		get: () => ipcRenderer.invoke("snapshot.get:v1", {}),
	}),
	character: Object.freeze({
		get: () => ipcRenderer.invoke("character.get:v1", {}),
		list: () => ipcRenderer.invoke("character.list:v1", {}),
		activate: (characterId: string) => ipcRenderer.invoke("character.activate:v1", { characterId }),
	}),
	events: Object.freeze({
		subscribe: (afterSeq: number) => ipcRenderer.invoke("events.subscribe:v1", { afterSeq }),
	}),
	onboarding: Object.freeze({
		get: () => ipcRenderer.invoke("onboarding.get:v1", {}),
		submit: (stepId: string, answer?: string) =>
			ipcRenderer.invoke(
				"onboarding.submit:v1",
				answer === undefined ? { stepId } : { stepId, answer },
			),
	}),
	conversation: Object.freeze({
		list: () => ipcRenderer.invoke("conversation.list:v1", {}),
		create: (title?: string) =>
			ipcRenderer.invoke("conversation.create:v1", title === undefined ? {} : { title }),
		select: (id: string, branchId?: string) =>
			ipcRenderer.invoke(
				"conversation.select:v1",
				branchId === undefined ? { id } : { id, branchId },
			),
		rename: (id: string, title: string) =>
			ipcRenderer.invoke("conversation.rename:v1", { id, title }),
		archive: (id: string, archived = true) =>
			ipcRenderer.invoke("conversation.archive:v1", { id, archived }),
		delete: (id: string) => ipcRenderer.invoke("conversation.delete:v1", { id }),
	}),
	message: Object.freeze({
		send: (conversationId: string, text: string) =>
			ipcRenderer.invoke("message.send:v1", { conversationId, text }),
		regenerate: (conversationId: string, messageId: string) =>
			ipcRenderer.invoke("message.regenerate:v1", { conversationId, messageId }),
		switchVersion: (conversationId: string, messageId: string, versionId: string) =>
			ipcRenderer.invoke("message.switchVersion:v1", { conversationId, messageId, versionId }),
		edit: (conversationId: string, messageId: string, text: string, isUserMessage: boolean) =>
			ipcRenderer.invoke("message.edit:v1", { conversationId, messageId, text, isUserMessage }),
		continue: (conversationId: string) =>
			ipcRenderer.invoke("message.continue:v1", { conversationId }),
		correct: (conversationId: string, reason: string, applyScope: string) =>
			ipcRenderer.invoke("message.correct:v1", { conversationId, reason, applyScope }),
		branch: (conversationId: string, messageId: string) =>
			ipcRenderer.invoke("message.branch:v1", { conversationId, messageId }),
		abort: (conversationId: string) => ipcRenderer.invoke("message.abort:v1", { conversationId }),
	}),
	memory: Object.freeze({
		listCandidates: () => ipcRenderer.invoke("memory.listCandidates:v1", {}),
		decideCandidate: (candidateId: string, decision: string, editedText?: string, scope?: string) =>
			ipcRenderer.invoke("memory.decideCandidate:v1", {
				candidateId,
				decision,
				...(editedText === undefined ? {} : { editedText }),
				...(scope === undefined ? {} : { scope }),
			}),
		search: (query: string, scope?: string) =>
			ipcRenderer.invoke("memory.search:v1", {
				query,
				...(scope === undefined ? {} : { scope }),
			}),
		list: (params?: Record<string, unknown>) => ipcRenderer.invoke("memory.list:v1", params ?? {}),
		pin: (entryId: string, pinned: boolean) =>
			ipcRenderer.invoke("memory.pin:v1", { entryId, pinned }),
		forget: (entryId: string) => ipcRenderer.invoke("memory.forget:v1", { entryId }),
		exclude: (entryId: string, excluded: boolean) =>
			ipcRenderer.invoke("memory.exclude:v1", { entryId, excluded }),
		edit: (entryId: string, newText: string) =>
			ipcRenderer.invoke("memory.edit:v1", { entryId, newText }),
	}),
	story: Object.freeze({
		listChanges: (branchId?: string) =>
			ipcRenderer.invoke("story.listChanges:v1", branchId === undefined ? {} : { branchId }),
		applyChange: (
			text: string,
			scope: "global" | "branch",
			conversationId?: string,
			branchId?: string,
		) =>
			ipcRenderer.invoke("story.applyChange:v1", {
				text,
				scope,
				...(conversationId === undefined ? {} : { conversationId }),
				...(branchId === undefined ? {} : { branchId }),
			}),
		revertChange: (changeId: string, conversationId?: string) =>
			ipcRenderer.invoke("story.revertChange:v1", {
				changeId,
				...(conversationId === undefined ? {} : { conversationId }),
			}),
		reset: (conversationId?: string, branchId?: string) =>
			ipcRenderer.invoke("story.reset:v1", {
				...(conversationId === undefined ? {} : { conversationId }),
				...(branchId === undefined ? {} : { branchId }),
			}),
		listProposals: (conversationId?: string) =>
			ipcRenderer.invoke(
				"story.listProposals:v1",
				conversationId === undefined ? {} : { conversationId },
			),
		resolveProposal: (proposalId: string, accept: boolean) =>
			ipcRenderer.invoke("story.resolveProposal:v1", { proposalId, accept }),
	}),
	canon: Object.freeze({
		listSources: () => ipcRenderer.invoke("canon.listSources:v1", {}),
		addSource: (logicalName: string, content: string) =>
			ipcRenderer.invoke("canon.addSource:v1", { logicalName, content }),
		search: (query: string) => ipcRenderer.invoke("canon.search:v1", { query }),
		removeSource: (sourceId: string) => ipcRenderer.invoke("canon.removeSource:v1", { sourceId }),
		listModules: () => ipcRenderer.invoke("canon.listModules:v1", {}),
		upsertModule: (params: Record<string, unknown>) =>
			ipcRenderer.invoke("canon.upsertModule:v1", params),
		deleteModule: (id: string) => ipcRenderer.invoke("canon.deleteModule:v1", { id }),
	}),
	provider: Object.freeze({
		list: () => ipcRenderer.invoke("provider.list:v1", {}),
		setApiKey: (providerId: string, apiKey: string, sessionOnly?: boolean) =>
			ipcRenderer.invoke("provider.setApiKey:v1", {
				providerId,
				apiKey,
				...(sessionOnly === undefined ? {} : { sessionOnly }),
			}),
		login: (providerId: string) =>
			ipcRenderer.invoke("provider.login:v1", { providerId, authType: "oauth" }),
		loginStatus: (providerId: string) =>
			ipcRenderer.invoke("provider.loginStatus:v1", { providerId }),
		loginAnswer: (providerId: string, answer: string) =>
			ipcRenderer.invoke("provider.loginAnswer:v1", { providerId, answer }),
		logout: (providerId: string) => ipcRenderer.invoke("provider.logout:v1", { providerId }),
	}),
	voice: Object.freeze({
		list: () => ipcRenderer.invoke("voice.list:v1", {}),
		pin: (providerId: string, modelId: string, label?: string) =>
			ipcRenderer.invoke("voice.pin:v1", {
				providerId,
				modelId,
				...(label === undefined ? {} : { label }),
			}),
		switch: (stackId: string, scope: string) =>
			ipcRenderer.invoke("voice.switch:v1", { stackId, scope, rollbackAvailable: true }),
	}),
	commission: Object.freeze({
		list: () => ipcRenderer.invoke("commission.list:v1", {}),
		draft: (params: {
			conversationId: string;
			title: string;
			description: string;
			reads?: string[];
			writes?: string[];
			networkAllowed?: boolean;
			toolNames?: string[];
		}) => ipcRenderer.invoke("commission.draft:v1", params),
		approve: (commissionId: string, approvedHash: string) =>
			ipcRenderer.invoke("commission.approve:v1", { commissionId, approvedHash }),
		reject: (commissionId: string) => ipcRenderer.invoke("commission.reject:v1", { commissionId }),
		launch: (commissionId: string, executorProfile: string) =>
			ipcRenderer.invoke("commission.launch:v1", { commissionId, executorProfile }),
	}),
	run: Object.freeze({
		list: () => ipcRenderer.invoke("run.list:v1", {}),
		steer: (runId: string, instruction: string) =>
			ipcRenderer.invoke("run.steer:v1", { runId, instruction }),
		cancel: (runId: string) => ipcRenderer.invoke("run.cancel:v1", { runId }),
		respondPermission: (runId: string, requestId: string, optionId: string) =>
			ipcRenderer.invoke("run.respondPermission:v1", { runId, requestId, optionId }),
	}),
	artifact: Object.freeze({
		list: () => ipcRenderer.invoke("artifact.list:v1", {}),
		read: (artifactId: string) => ipcRenderer.invoke("artifact.read:v1", { artifactId }),
	}),
	settings: Object.freeze({
		get: () => ipcRenderer.invoke("settings.get:v1", {}),
		set: (settings: Record<string, unknown>) => ipcRenderer.invoke("settings.set:v1", { settings }),
	}),
});

contextBridge.exposeInMainWorld(
	"bearDesktop",
	Object.freeze({
		platform: process.platform,
		diagnostics: Object.freeze({
			reportRendererFault,
		}),
		companion: companionFacade,
	}),
);
