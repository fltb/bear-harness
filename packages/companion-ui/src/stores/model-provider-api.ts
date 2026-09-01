import type { CompanionClient } from "@bear-harness/companion-client";
import type { QueryClient } from "@tanstack/solid-query";
import type { ConfiguredModel, ModelRouteData, ProviderLoginResult, SettingsData } from "./ipc.js";
import { invoke } from "./ipc.js";
import { queryKeys, refreshRpcQuery } from "./rpc-query.js";
import type { ModelApi, ProviderApi, SettingsApi } from "./supplementary-api.js";

export function createModelProviderApis(c: {
	client: CompanionClient;
	queryClient: QueryClient;
	cacheRevision(): number;
	settings(): { settings: SettingsData } | undefined;
	providers(): ProviderApi["providers"] extends () => infer T ? T : never;
	models(): ConfiguredModel[];
	defaults(): {
		reply?: { providerId: string; modelId: string };
		vision: { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } };
		onboardingComplete: boolean;
	};
	systemDefaults(): {
		reply?: { providerId: string; modelId: string };
		vision: { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } };
	};
	currentRoute(): ModelRouteData | undefined;
	activeConversationId(): string | null;
	onRefreshError(error: unknown): void;
}): { settingsApi: SettingsApi; providerApi: ProviderApi; modelApi: ModelApi } {
	const { client, queryClient } = c;
	const refreshPool = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.modelPool,
			request: () => invoke(client, () => client.model.poolGet()),
		});
	const refreshDefaults = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.modelDefaults,
			request: () => invoke(client, () => client.model.defaultsGet()),
		});
	const refreshSystemDefaults = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.systemModelDefaults,
			request: () => invoke(client, () => client.model.systemDefaultsGet()),
		});
	const refreshRoute = (conversationId: string) =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.modelRoute(conversationId),
			request: () => invoke(client, () => client.model.routeGet({ conversationId })),
		});
	const settingsApi: SettingsApi = {
		data: () => {
			c.cacheRevision();
			return c.settings()?.settings;
		},
		get: async () =>
			(
				await refreshRpcQuery({
					client: queryClient,
					key: queryKeys.settings,
					request: () => invoke(client, () => client.settings.get()),
				})
			).settings,
		set: async (settings) => {
			await invoke(client, () => client.settings.set({ settings }));
			await settingsApi.get();
		},
	};
	const providerApi: ProviderApi = {
		loginState: (id) => {
			c.cacheRevision();
			return queryClient.getQueryData<ProviderLoginResult>(queryKeys.providerLogin(id));
		},
		providers: c.providers,
		list: () =>
			refreshRpcQuery({
				client: queryClient,
				key: queryKeys.providers,
				request: () => invoke(client, () => client.provider.list()),
			}),
		customUpsert: async (params) => {
			await invoke(client, () => client.provider.customUpsert(params));
		},
		importPiConfig: async (configJson) => {
			const result = await invoke(client, () => client.provider.importPiConfig({ configJson }));
			await refreshPool();
			return result.models;
		},
		overrideBaseUrl: async (params) => {
			await invoke(client, () => client.provider.overrideBaseUrl(params));
		},
		setApiKey: async (providerId, apiKey, sessionOnly) => {
			await invoke(client, () => client.provider.setApiKey({ providerId, apiKey, sessionOnly }));
		},
		login: async (providerId) => {
			const key = queryKeys.providerLogin(providerId);
			const before = queryClient.getQueryData<ProviderLoginResult>(key);
			const state = await invoke(client, () =>
				client.provider.login({ providerId, authType: "oauth" }),
			);
			queryClient.setQueryData<ProviderLoginResult>(key, (current) =>
				current === before ? state : current,
			);
			return state;
		},
		loginStatus: (providerId) =>
			refreshRpcQuery({
				client: queryClient,
				key: queryKeys.providerLogin(providerId),
				request: () => invoke(client, () => client.provider.loginStatus({ providerId })),
			}),
		loginAnswer: async (providerId, answer) => {
			const key = queryKeys.providerLogin(providerId);
			const before = queryClient.getQueryData<ProviderLoginResult>(key);
			const state = await invoke(client, () => client.provider.loginAnswer({ providerId, answer }));
			queryClient.setQueryData<ProviderLoginResult>(key, (current) =>
				current === before ? state : current,
			);
			return state;
		},
		loginCancel: async (providerId) => {
			await invoke(client, () => client.provider.loginCancel({ providerId }));
			queryClient.removeQueries({ queryKey: queryKeys.providerLogin(providerId), exact: true });
		},
		logout: async (providerId) => {
			await invoke(client, () => client.provider.logout({ providerId }));
			queryClient.removeQueries({ queryKey: queryKeys.providerLogin(providerId), exact: true });
		},
		remove: async (providerId) => {
			await invoke(client, () => client.provider.remove({ providerId }));
			queryClient.removeQueries({ queryKey: queryKeys.providerLogin(providerId), exact: true });
			await Promise.all([
				providerApi.list(),
				refreshPool(),
				refreshDefaults(),
				refreshSystemDefaults(),
				...(c.activeConversationId() ? [refreshRoute(c.activeConversationId()!)] : []),
			]);
		},
	};
	const data = () => {
		const raw = c.defaults();
		const defaults = {
			vision: raw.vision,
			onboardingComplete: raw.onboardingComplete,
			...(raw.reply ? { reply: raw.reply } : {}),
		};
		const selected = c.currentRoute()?.selected;
		return {
			models: c.models(),
			defaults,
			systemDefaults: c.systemDefaults(),
			...(selected ? { selected } : {}),
			...(defaults.vision.mode === "manual" ? { multimodalFallback: defaults.vision.route } : {}),
		};
	};
	const modelApi: ModelApi = {
		data,
		models: c.models,
		loading: () => false,
		error: () => undefined,
		refetch: () => {
			void refreshPool().catch(c.onRefreshError);
			void refreshDefaults().catch(c.onRefreshError);
			void refreshSystemDefaults().catch(c.onRefreshError);
			if (c.activeConversationId())
				void refreshRoute(c.activeConversationId()!).catch(c.onRefreshError);
		},
		list: async (conversationId) => {
			await Promise.all([
				refreshPool(),
				refreshDefaults(),
				refreshSystemDefaults(),
				...(conversationId ? [refreshRoute(conversationId)] : []),
			]);
			return data();
		},
		enable: async (providerId, modelId, label) => {
			await invoke(client, () => client.model.enable({ providerId, modelId, label }));
			await Promise.all([refreshPool(), refreshDefaults(), refreshSystemDefaults()]);
		},
		disable: async (providerId, modelId) => {
			await invoke(client, () => client.model.disable({ providerId, modelId }));
			await Promise.all([refreshPool(), refreshDefaults(), refreshSystemDefaults()]);
		},
		select: async (conversationId, providerId, modelId) => {
			await invoke(client, () =>
				client.model.routeSet({ conversationId, selected: { providerId, modelId } }),
			);
			await refreshRoute(conversationId);
		},
		setMultimodalFallback: async (providerId, modelId) => {
			await invoke(client, () =>
				client.model.defaultsSetVision({ mode: "manual", route: { providerId, modelId } }),
			);
			await refreshDefaults();
		},
		setDefaultReply: async (providerId, modelId) => {
			await invoke(client, () => client.model.defaultsSetReply({ reply: { providerId, modelId } }));
			await refreshDefaults();
		},
		clearDefaultReply: async () => {
			await invoke(client, () => client.model.defaultsSetReply({ reply: null }));
			await refreshDefaults();
		},
		setVisionAuto: async () => {
			await invoke(client, () => client.model.defaultsSetVision({ mode: "auto" }));
			await refreshDefaults();
		},
		setSystemDefaults: async (reply, vision) => {
			await invoke(client, () => client.model.systemDefaultsSet({ reply, vision }));
			await refreshSystemDefaults();
		},
		initializeDefaults: async () => {
			await invoke(client, () => client.model.defaultsInitialize());
			await refreshDefaults();
		},
		completeDefaultsOnboarding: async () => {
			await invoke(client, () => client.model.defaultsCompleteOnboarding());
			await refreshDefaults();
		},
	};
	return { settingsApi, providerApi, modelApi };
}
