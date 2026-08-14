/**
 * Renderer-facing global declarations: the compile-time injected product
 * config and the preload bridge surface. Type-only; no runtime code.
 */

import type { ProductConfig } from "../../product.config";

declare global {
	const __PRODUCT_CONFIG__: Readonly<ProductConfig>;

	interface Window {
		bearDesktop: Readonly<{
			platform: "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32";
			diagnostics: Readonly<{
				reportRendererFault(input: unknown): void;
			}>;
			companion: Readonly<{
				snapshot: { get(): Promise<unknown> };
				events: { subscribe(afterSeq: number): Promise<unknown> };
				onboarding: {
					get(): Promise<unknown>;
					setName(name: string): Promise<unknown>;
					setRelation(kind: string): Promise<unknown>;
					setMemoryDecision(enabled: boolean): Promise<unknown>;
				};
				conversation: {
					list(): Promise<unknown>;
					create(title?: string): Promise<unknown>;
					select(id: string, branchId?: string): Promise<unknown>;
				};
				message: {
					send(conversationId: string, text: string): Promise<unknown>;
					regenerate(conversationId: string, messageId: string): Promise<unknown>;
					switchVersion(conversationId: string, messageId: string, versionId: string): Promise<unknown>;
					edit(conversationId: string, messageId: string, text: string, isUserMessage: boolean): Promise<unknown>;
					continue(conversationId: string): Promise<unknown>;
					correct(conversationId: string, reason: string, applyScope: string): Promise<unknown>;
					branch(conversationId: string, messageId: string): Promise<unknown>;
					abort(conversationId: string): Promise<unknown>;
				};
				memory: {
					listCandidates(): Promise<unknown>;
					decideCandidate(candidateId: string, decision: string, editedText?: string, scope?: string): Promise<unknown>;
					search(query: string, scope?: string): Promise<unknown>;
				};
				provider: {
					list(): Promise<unknown>;
					setApiKey(providerId: string, apiKey: string, sessionOnly?: boolean): Promise<unknown>;
					login(providerId: string): Promise<unknown>;
					logout(providerId: string): Promise<unknown>;
				};
				voice: {
					list(): Promise<unknown>;
					switch(stackId: string, scope: string): Promise<unknown>;
				};
				commission: { list(): Promise<unknown> };
				run: { list(): Promise<unknown> };
				artifact: { list(): Promise<unknown> };
				settings: {
					get(): Promise<unknown>;
					set(settings: Record<string, unknown>): Promise<unknown>;
				};
			}>;
		}>;
	}
}
