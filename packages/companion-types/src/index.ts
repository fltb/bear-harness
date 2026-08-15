/**
 * Type-only contract for the renderer-facing companion bridge.
 *
 * The Electron preload and every development transport implement this shape.
 * This package emits declarations only: importing these symbols with
 * `import type` cannot add code to a renderer or preload bundle.
 */
export interface HostTransport {
	/** Invoke one Host RPC channel with a JSON-serializable payload. */
	invoke(channel: string, payload: unknown): Promise<unknown>;
}

/**
 * The complete companion facade exposed as `window.bearDesktop.companion`.
 * Methods resolve to the raw Host response envelope; consumers unwrap it at
 * their domain boundary.
 */
export interface CompanionClient {
	readonly snapshot: {
		get(): Promise<unknown>;
	};
	readonly character: {
		get(): Promise<unknown>;
		list(): Promise<unknown>;
		activate(characterId: string): Promise<unknown>;
	};
	readonly events: {
		subscribe(afterSeq: number): Promise<unknown>;
	};
	readonly onboarding: {
		get(): Promise<unknown>;
		submit(stepId: string, answer?: string): Promise<unknown>;
	};
	readonly conversation: {
		list(): Promise<unknown>;
		create(title?: string): Promise<unknown>;
		select(id: string, branchId?: string): Promise<unknown>;
		rename(id: string, title: string): Promise<unknown>;
		archive(id: string, archived?: boolean): Promise<unknown>;
		delete(id: string): Promise<unknown>;
	};
	readonly message: {
		send(conversationId: string, text: string): Promise<unknown>;
		regenerate(conversationId: string, messageId: string): Promise<unknown>;
		switchVersion(conversationId: string, messageId: string, versionId: string): Promise<unknown>;
		edit(
			conversationId: string,
			messageId: string,
			text: string,
			isUserMessage: boolean,
		): Promise<unknown>;
		continue(conversationId: string): Promise<unknown>;
		correct(conversationId: string, reason: string, applyScope: string): Promise<unknown>;
		branch(conversationId: string, messageId: string): Promise<unknown>;
		abort(conversationId: string): Promise<unknown>;
	};
	readonly memory: {
		listCandidates(): Promise<unknown>;
		decideCandidate(
			candidateId: string,
			decision: string,
			editedText?: string,
			scope?: string,
		): Promise<unknown>;
		search(query: string, scope?: string): Promise<unknown>;
		list(params?: Record<string, unknown>): Promise<unknown>;
		pin(entryId: string, pinned: boolean): Promise<unknown>;
		forget(entryId: string): Promise<unknown>;
		exclude(entryId: string, excluded: boolean): Promise<unknown>;
		edit(entryId: string, newText: string): Promise<unknown>;
	};
	readonly story: {
		listChanges(branchId?: string): Promise<unknown>;
		applyChange(
			text: string,
			scope: "global" | "branch",
			conversationId?: string,
			branchId?: string,
		): Promise<unknown>;
		revertChange(changeId: string, conversationId?: string): Promise<unknown>;
		reset(conversationId?: string, branchId?: string): Promise<unknown>;
		listProposals(conversationId?: string): Promise<unknown>;
		resolveProposal(proposalId: string, accept: boolean): Promise<unknown>;
	};
	readonly canon: {
		listSources(): Promise<unknown>;
		addSource(logicalName: string, content: string): Promise<unknown>;
		search(query: string): Promise<unknown>;
		removeSource(sourceId: string): Promise<unknown>;
		listModules(): Promise<unknown>;
		upsertModule(params: Record<string, unknown>): Promise<unknown>;
		deleteModule(id: string): Promise<unknown>;
	};
	readonly provider: {
		list(): Promise<unknown>;
		customUpsert(params: {
			providerId: string;
			name: string;
			baseUrl: string;
			modelId: string;
			apiKey?: string;
			supportsImages?: boolean;
		}): Promise<unknown>;
		overrideBaseUrl(params: { providerId: string; baseUrl: string }): Promise<unknown>;
		setApiKey(providerId: string, apiKey: string, sessionOnly?: boolean): Promise<unknown>;
		login(providerId: string): Promise<unknown>;
		loginStatus(providerId: string): Promise<unknown>;
		loginAnswer(providerId: string, answer: string): Promise<unknown>;
		logout(providerId: string): Promise<unknown>;
	};
	readonly voice: {
		list(): Promise<unknown>;
		pin(providerId: string, modelId: string, label?: string): Promise<unknown>;
		switch(stackId: string, scope: string): Promise<unknown>;
	};
	readonly commission: {
		list(): Promise<unknown>;
		draft(params: {
			conversationId: string;
			title: string;
			description: string;
			reads?: string[];
			writes?: string[];
			networkAllowed?: boolean;
			toolNames?: string[];
		}): Promise<unknown>;
		approve(commissionId: string, approvedHash: string): Promise<unknown>;
		reject(commissionId: string): Promise<unknown>;
		launch(commissionId: string, executorProfile: string): Promise<unknown>;
	};
	readonly run: {
		list(): Promise<unknown>;
		steer(runId: string, instruction: string): Promise<unknown>;
		cancel(runId: string): Promise<unknown>;
		respondPermission(runId: string, requestId: string, optionId: string): Promise<unknown>;
	};
	readonly artifact: {
		list(): Promise<unknown>;
		read(artifactId: string): Promise<unknown>;
	};
	readonly settings: {
		get(): Promise<unknown>;
		set(settings: Record<string, unknown>): Promise<unknown>;
	};
}
