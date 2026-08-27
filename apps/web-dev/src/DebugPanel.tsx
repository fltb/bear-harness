import type { HostTransport } from "@bear-harness/companion-client";
import {
	createStableSnapshot,
	markSelectPortalTopLayer,
	useCompanionStore,
} from "@bear-harness/companion-ui";
import { i18n, useTranslation } from "@bear-harness/i18n";
import { CHANNEL_CONTRACTS, IpcResponse } from "@bear-harness/protocol/schema";
import { Button } from "@kobalte/core/button";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { createMutation, createQuery, useQueryClient } from "@tanstack/solid-query";
import { createSignal, Show } from "solid-js";
import { loadDebugChannels } from "./http-client";
import "./web-dev-debug.css";

function format(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/**
 * WebDev-only Host console. It uses the same authenticated HTTP transport as
 * the application surface, exposes every registered RPC channel, and keeps
 * provider setup explicit rather than probing pi-ai during page bootstrap.
 */
export function WebDevDebugPanel(props: { transport: HostTransport; token: string }) {
	const [t] = useTranslation(undefined, { i18n });
	const [open, setOpen] = createSignal(false);
	const store = useCompanionStore();
	const cache = useQueryClient();
	const channelsQuery = createQuery(() => ({
		queryKey: ["webdev", "channels"],
		queryFn: () => loadDebugChannels(props.token),
		enabled: open(),
		staleTime: Infinity,
	}));
	const channels = () => channelsQuery.data ?? [];
	const [chosenChannel, setChannel] = createSignal("");
	const channel = () => chosenChannel() || channels()[0] || "";
	const [params, setParams] = createSignal("{}");
	const [output, setOutput] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);
	const providers = () => store.provider.providers();
	const [chosenProvider, setProviderId] = createSignal("");
	const providerId = () => chosenProvider() || providers()[0]?.id || "";
	const [apiKey, setApiKey] = createSignal("");
	const providerOptions = createStableSnapshot(() =>
		providers().map((provider) => ({
			...provider,
			label: `${provider.name} - ${provider.credentialStatus}`,
		})),
	);
	const channelOptions = createStableSnapshot(() => channels().map((id) => ({ id, label: id })));

	const toggle = () => setOpen((value) => !value);
	const invocation = createMutation(() => ({
		retry: false,
		gcTime: 0,
		mutationFn: async () => {
			try {
				const parsed: unknown = JSON.parse(params());
				const endpoint = CHANNEL_CONTRACTS[channel()];
				if (!endpoint) throw new Error("unknown RPC channel");
				const request = endpoint.request.parse(parsed);
				const response =
					endpoint.operation === "mutation"
						? await props.transport.invoke(endpoint, request)
						: await cache.fetchQuery({
								queryKey: ["webdev", "inspection", crypto.randomUUID()],
								queryFn: () => props.transport.invoke(endpoint, request),
								gcTime: 0,
							});
				const validated = IpcResponse(endpoint.response).parse(response);
				setOutput(format(validated));
				setError(null);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "debug RPC failed");
			}
		},
	}));
	const invokeRaw = () => invocation.mutateAsync();
	const loadProviders = async () => {
		try {
			const result = await store.provider.list();
			setOutput(format(result));
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "provider configuration failed");
		}
	};
	const setSessionKey = async () => {
		try {
			await store.provider.setApiKey(providerId(), apiKey(), true);
			setApiKey("");
			await loadProviders();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "provider configuration failed");
		}
	};

	return (
		<>
			<Button type="button" class="web-dev-debug-toggle" onClick={toggle}>
				Web Dev
			</Button>
			<Show when={open()}>
				<aside class="web-dev-debug-panel" aria-label={t("webDev.ariaLabel")}>
					<header>
						<strong>{t("webDev.title")}</strong>
						<Button type="button" onClick={toggle} aria-label={t("webDev.close")}>
							{t("webDev.close")}
						</Button>
					</header>
					<p>{t("webDev.description")}</p>
					<section>
						<h2>{t("webDev.providerSection")}</h2>
						<Button type="button" onClick={() => void loadProviders()}>
							{t("webDev.loadProviders")}
						</Button>
						<Show when={providers().length > 0}>
							<Select
								options={providerOptions()}
								value={providerOptions().find((provider) => provider.id === providerId()) ?? null}
								optionValue="id"
								optionTextValue="label"
								onChange={(provider) => setProviderId(provider?.id ?? "")}
								itemComponent={(itemProps) => (
									<Select.Item item={itemProps.item} class="select-item">
										<Select.ItemLabel>{itemProps.item.rawValue.label}</Select.ItemLabel>
									</Select.Item>
								)}
							>
								<Select.Label>Provider</Select.Label>
								<Select.Trigger class="select-trigger">
									<Select.Value class="select-value" />
								</Select.Trigger>
								<Select.Portal ref={markSelectPortalTopLayer}>
									<Select.Content class="select-content">
										<Select.Listbox class="select-listbox" />
									</Select.Content>
								</Select.Portal>
							</Select>
							<TextField>
								<TextField.Label>{t("webDev.sessionApiKey")}</TextField.Label>
								<TextField.Input
									type="password"
									value={apiKey()}
									onInput={(event) => setApiKey(event.currentTarget.value)}
								/>
							</TextField>
							<Button
								type="button"
								disabled={!providerId() || apiKey().length === 0}
								onClick={() => void setSessionKey()}
							>
								{t("webDev.saveSessionKey")}
							</Button>
						</Show>
					</section>
					<section>
						<h2>{t("webDev.rpcSection")}</h2>
						<Select
							options={channelOptions()}
							value={channelOptions().find((entry) => entry.id === channel()) ?? null}
							optionValue="id"
							optionTextValue="label"
							onChange={(entry) => setChannel(entry?.id ?? "")}
							itemComponent={(itemProps) => (
								<Select.Item item={itemProps.item} class="select-item">
									<Select.ItemLabel>{itemProps.item.rawValue.label}</Select.ItemLabel>
								</Select.Item>
							)}
						>
							<Select.Label>Channel</Select.Label>
							<Select.Trigger class="select-trigger">
								<Select.Value class="select-value" />
							</Select.Trigger>
							<Select.Portal ref={markSelectPortalTopLayer}>
								<Select.Content class="select-content">
									<Select.Listbox class="select-listbox" />
								</Select.Content>
							</Select.Portal>
						</Select>
						<TextField>
							<TextField.Label>{t("webDev.rpcParameters")}</TextField.Label>
							<TextField.TextArea
								value={params()}
								onInput={(event) => setParams(event.currentTarget.value)}
							/>
						</TextField>
						<Button type="button" disabled={!channel()} onClick={() => void invokeRaw()}>
							{t("webDev.invokeHost")}
						</Button>
					</section>
					<Show when={error()}>{(message) => <p class="web-dev-debug-error">{message()}</p>}</Show>
					<Show when={output()}>{(value) => <pre role="status">{value()}</pre>}</Show>
				</aside>
			</Show>
		</>
	);
}
