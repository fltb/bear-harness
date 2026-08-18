import type { CompanionClient, HostTransport } from "@bear-harness/companion-client";
import { unwrap } from "@bear-harness/companion-client";
import { i18n, useTranslation } from "@bear-harness/i18n";
import { CHANNEL_CONTRACTS } from "@bear-harness/protocol/schema";
import { Button } from "@kobalte/core/button";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { createSignal, Show } from "solid-js";
import { loadDebugChannels } from "./http-client";
import "./web-dev-debug.css";

interface ProviderSummary {
	id: string;
	name: string;
	credentialStatus: string;
}

function format(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/**
 * WebDev-only Host console. It uses the same authenticated HTTP transport as
 * the application surface, exposes every registered RPC channel, and keeps
 * provider setup explicit rather than probing pi-ai during page bootstrap.
 */
export function WebDevDebugPanel(props: {
	client: CompanionClient;
	transport: HostTransport;
	token: string;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const [open, setOpen] = createSignal(false);
	const [channels, setChannels] = createSignal<string[]>([]);
	const [channel, setChannel] = createSignal("");
	const [params, setParams] = createSignal("{}");
	const [output, setOutput] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);
	const [providers, setProviders] = createSignal<ProviderSummary[]>([]);
	const [providerId, setProviderId] = createSignal("");
	const [apiKey, setApiKey] = createSignal("");
	const providerOptions = () =>
		providers().map((provider) => ({
			...provider,
			label: `${provider.name} - ${provider.credentialStatus}`,
		}));
	const channelOptions = () => channels().map((id) => ({ id, label: id }));

	const loadChannels = async () => {
		try {
			const next = await loadDebugChannels(props.token);
			setChannels(next);
			if (!channel() && next[0]) setChannel(next[0]);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "failed to load debug channels");
		}
	};
	const toggle = () => {
		const next = !open();
		setOpen(next);
		if (next && channels().length === 0) void loadChannels();
	};
	const invokeRaw = async () => {
		try {
			const parsed: unknown = JSON.parse(params());
			const endpoint = CHANNEL_CONTRACTS[channel()];
			if (!endpoint) throw new Error("unknown RPC channel");
			const result = await props.transport.invoke(endpoint, endpoint.request.parse(parsed));
			setOutput(format(result));
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "debug RPC failed");
		}
	};
	const loadProviders = async () => {
		try {
			const result = await unwrap<{ providers: ProviderSummary[] }>(props.client.provider.list());
			setProviders(result.providers);
			if (!providerId() && result.providers[0]) setProviderId(result.providers[0].id);
			setOutput(format(result));
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "provider configuration failed");
		}
	};
	const setSessionKey = async () => {
		try {
			await unwrap(
				props.client.provider.setApiKey({
					providerId: providerId(),
					apiKey: apiKey(),
					sessionOnly: true,
				}),
			);
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
								<Select.Portal>
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
							<Select.Portal>
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
