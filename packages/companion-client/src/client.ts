/**
 * Neutral companion facade over `HostTransport`.
 *
 * `CompanionClient` exactly mirrors the preload-exposed companion facade
 * (`window.bearDesktop.companion` in the desktop app): same groups, same
 * method names, same parameter shapes, same request payload shaping, and the
 * same `Promise<unknown>` return type (the raw wire envelope, unwrapped with
 * `unwrap` from this package). The returned client is frozen, matching the
 * preload's `Object.freeze`.
 */
import type { CompanionClient, HostTransport } from "@bear-harness/companion-types";

/** Build the companion facade over a `HostTransport`. */
export function createCompanionClient(transport: HostTransport): CompanionClient {
	return Object.freeze({
		snapshot: Object.freeze({
			get: () => transport.invoke("snapshot.get:v1", {}),
		}),
		character: Object.freeze({
			get: () => transport.invoke("character.get:v1", {}),
			list: () => transport.invoke("character.list:v1", {}),
			activate: (characterId: string) => transport.invoke("character.activate:v1", { characterId }),
		}),
		events: Object.freeze({
			subscribe: (afterSeq: number) => transport.invoke("events.subscribe:v1", { afterSeq }),
		}),
		onboarding: Object.freeze({
			get: () => transport.invoke("onboarding.get:v1", {}),
			submit: (stepId: string, answer?: string) =>
				transport.invoke(
					"onboarding.submit:v1",
					answer === undefined ? { stepId } : { stepId, answer },
				),
		}),
		conversation: Object.freeze({
			list: () => transport.invoke("conversation.list:v1", {}),
			create: (title?: string) =>
				transport.invoke("conversation.create:v1", title === undefined ? {} : { title }),
			select: (id: string, branchId?: string) =>
				transport.invoke(
					"conversation.select:v1",
					branchId === undefined ? { id } : { id, branchId },
				),
			rename: (id: string, title: string) =>
				transport.invoke("conversation.rename:v1", { id, title }),
			archive: (id: string, archived = true) =>
				transport.invoke("conversation.archive:v1", { id, archived }),
			delete: (id: string) => transport.invoke("conversation.delete:v1", { id }),
		}),
		message: Object.freeze({
			send: (conversationId: string, text: string) =>
				transport.invoke("message.send:v1", { conversationId, text }),
			regenerate: (conversationId: string, messageId: string) =>
				transport.invoke("message.regenerate:v1", { conversationId, messageId }),
			switchVersion: (conversationId: string, messageId: string, versionId: string) =>
				transport.invoke("message.switchVersion:v1", {
					conversationId,
					messageId,
					versionId,
				}),
			edit: (conversationId: string, messageId: string, text: string, isUserMessage: boolean) =>
				transport.invoke("message.edit:v1", { conversationId, messageId, text, isUserMessage }),
			continue: (conversationId: string) =>
				transport.invoke("message.continue:v1", { conversationId }),
			correct: (conversationId: string, reason: string, applyScope: string) =>
				transport.invoke("message.correct:v1", { conversationId, reason, applyScope }),
			branch: (conversationId: string, messageId: string) =>
				transport.invoke("message.branch:v1", { conversationId, messageId }),
			abort: (conversationId: string) => transport.invoke("message.abort:v1", { conversationId }),
		}),
		memory: Object.freeze({
			listCandidates: () => transport.invoke("memory.listCandidates:v1", {}),
			decideCandidate: (
				candidateId: string,
				decision: string,
				editedText?: string,
				scope?: string,
			) =>
				transport.invoke("memory.decideCandidate:v1", {
					candidateId,
					decision,
					...(editedText === undefined ? {} : { editedText }),
					...(scope === undefined ? {} : { scope }),
				}),
			search: (query: string, scope?: string) =>
				transport.invoke("memory.search:v1", {
					query,
					...(scope === undefined ? {} : { scope }),
				}),
			list: (params?: Record<string, unknown>) => transport.invoke("memory.list:v1", params ?? {}),
			pin: (entryId: string, pinned: boolean) =>
				transport.invoke("memory.pin:v1", { entryId, pinned }),
			forget: (entryId: string) => transport.invoke("memory.forget:v1", { entryId }),
			exclude: (entryId: string, excluded: boolean) =>
				transport.invoke("memory.exclude:v1", { entryId, excluded }),
			edit: (entryId: string, newText: string) =>
				transport.invoke("memory.edit:v1", { entryId, newText }),
		}),
		story: Object.freeze({
			listChanges: (branchId?: string) =>
				transport.invoke("story.listChanges:v1", branchId === undefined ? {} : { branchId }),
			applyChange: (
				text: string,
				scope: "global" | "branch",
				conversationId?: string,
				branchId?: string,
			) =>
				transport.invoke("story.applyChange:v1", {
					text,
					scope,
					...(conversationId === undefined ? {} : { conversationId }),
					...(branchId === undefined ? {} : { branchId }),
				}),
			revertChange: (changeId: string, conversationId?: string) =>
				transport.invoke("story.revertChange:v1", {
					changeId,
					...(conversationId === undefined ? {} : { conversationId }),
				}),
			reset: (conversationId?: string, branchId?: string) =>
				transport.invoke("story.reset:v1", {
					...(conversationId === undefined ? {} : { conversationId }),
					...(branchId === undefined ? {} : { branchId }),
				}),
			listProposals: (conversationId?: string) =>
				transport.invoke(
					"story.listProposals:v1",
					conversationId === undefined ? {} : { conversationId },
				),
			resolveProposal: (proposalId: string, accept: boolean) =>
				transport.invoke("story.resolveProposal:v1", { proposalId, accept }),
		}),
		canon: Object.freeze({
			listSources: () => transport.invoke("canon.listSources:v1", {}),
			addSource: (logicalName: string, content: string) =>
				transport.invoke("canon.addSource:v1", { logicalName, content }),
			search: (query: string) => transport.invoke("canon.search:v1", { query }),
			removeSource: (sourceId: string) => transport.invoke("canon.removeSource:v1", { sourceId }),
			listModules: () => transport.invoke("canon.listModules:v1", {}),
			upsertModule: (params: Record<string, unknown>) =>
				transport.invoke("canon.upsertModule:v1", params),
			deleteModule: (id: string) => transport.invoke("canon.deleteModule:v1", { id }),
		}),
		provider: Object.freeze({
			list: () => transport.invoke("provider.list:v1", {}),
			customUpsert: (params: {
				providerId: string;
				name: string;
				baseUrl: string;
				modelId: string;
				apiKey?: string;
				supportsImages?: boolean;
			}) => transport.invoke("provider.customUpsert:v1", params),
			overrideBaseUrl: (params: { providerId: string; baseUrl: string }) =>
				transport.invoke("provider.overrideBaseUrl:v1", params),
			setApiKey: (providerId: string, apiKey: string, sessionOnly?: boolean) =>
				transport.invoke("provider.setApiKey:v1", {
					providerId,
					apiKey,
					...(sessionOnly === undefined ? {} : { sessionOnly }),
				}),
			login: (providerId: string) =>
				transport.invoke("provider.login:v1", { providerId, authType: "oauth" }),
			loginStatus: (providerId: string) =>
				transport.invoke("provider.loginStatus:v1", { providerId }),
			loginAnswer: (providerId: string, answer: string) =>
				transport.invoke("provider.loginAnswer:v1", { providerId, answer }),
			logout: (providerId: string) => transport.invoke("provider.logout:v1", { providerId }),
		}),
		voice: Object.freeze({
			list: () => transport.invoke("voice.list:v1", {}),
			pin: (providerId: string, modelId: string, label?: string) =>
				transport.invoke("voice.pin:v1", {
					providerId,
					modelId,
					...(label === undefined ? {} : { label }),
				}),
			switch: (stackId: string, scope: string) =>
				transport.invoke("voice.switch:v1", { stackId, scope, rollbackAvailable: true }),
		}),
		commission: Object.freeze({
			list: () => transport.invoke("commission.list:v1", {}),
			draft: (params: {
				conversationId: string;
				title: string;
				description: string;
				reads?: string[];
				writes?: string[];
				networkAllowed?: boolean;
				toolNames?: string[];
			}) => transport.invoke("commission.draft:v1", params),
			approve: (commissionId: string, approvedHash: string) =>
				transport.invoke("commission.approve:v1", { commissionId, approvedHash }),
			reject: (commissionId: string) => transport.invoke("commission.reject:v1", { commissionId }),
			launch: (commissionId: string, executorProfile: string) =>
				transport.invoke("commission.launch:v1", { commissionId, executorProfile }),
		}),
		run: Object.freeze({
			list: () => transport.invoke("run.list:v1", {}),
			steer: (runId: string, instruction: string) =>
				transport.invoke("run.steer:v1", { runId, instruction }),
			cancel: (runId: string) => transport.invoke("run.cancel:v1", { runId }),
			respondPermission: (runId: string, requestId: string, optionId: string) =>
				transport.invoke("run.respondPermission:v1", { runId, requestId, optionId }),
		}),
		artifact: Object.freeze({
			list: () => transport.invoke("artifact.list:v1", {}),
			read: (artifactId: string) => transport.invoke("artifact.read:v1", { artifactId }),
		}),
		settings: Object.freeze({
			get: () => transport.invoke("settings.get:v1", {}),
			set: (settings: Record<string, unknown>) => transport.invoke("settings.set:v1", { settings }),
		}),
	});
}
