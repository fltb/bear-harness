import type { CompanionClient, HostTransport } from "@bear-harness/companion-client";
import { unwrap } from "@bear-harness/companion-client";
import { t } from "@bear-harness/companion-ui";
import { CHANNEL_CONTRACTS } from "@bear-harness/protocol/schema";
import { createSignal, For, Show } from "solid-js";
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
	const [open, setOpen] = createSignal(false);
	const [channels, setChannels] = createSignal<string[]>([]);
	const [channel, setChannel] = createSignal("");
	const [params, setParams] = createSignal("{}");
	const [output, setOutput] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);
	const [providers, setProviders] = createSignal<ProviderSummary[]>([]);
	const [providerId, setProviderId] = createSignal("");
	const [apiKey, setApiKey] = createSignal("");

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
			<button type="button" class="web-dev-debug-toggle" onClick={toggle}>
				Web Dev
			</button>
			<Show when={open()}>
				<aside class="web-dev-debug-panel" aria-label={t("webDev.ariaLabel")}>
					<header>
						<strong>{t("webDev.title")}</strong>
						<button type="button" onClick={toggle} aria-label={t("webDev.close")}>
							{t("webDev.close")}
						</button>
					</header>
					<p>{t("webDev.description")}</p>
					<section>
						<h2>{t("webDev.providerSection")}</h2>
						<button type="button" onClick={() => void loadProviders()}>
							{t("webDev.loadProviders")}
						</button>
						<Show when={providers().length > 0}>
							<label>
								Provider
								<select
									value={providerId()}
									onChange={(event) => setProviderId(event.currentTarget.value)}
								>
									<For each={providers()}>
										{(provider) => (
											<option value={provider.id}>
												{provider.name} · {provider.credentialStatus}
											</option>
										)}
									</For>
								</select>
							</label>
							<label>
								{t("webDev.sessionApiKey")}
								<input
									type="password"
									value={apiKey()}
									onInput={(event) => setApiKey(event.currentTarget.value)}
								/>
							</label>
							<button
								type="button"
								disabled={!providerId() || apiKey().length === 0}
								onClick={() => void setSessionKey()}
							>
								{t("webDev.saveSessionKey")}
							</button>
						</Show>
					</section>
					<section>
						<h2>{t("webDev.rpcSection")}</h2>
						<label>
							Channel
							<select value={channel()} onChange={(event) => setChannel(event.currentTarget.value)}>
								<For each={channels()}>{(entry) => <option value={entry}>{entry}</option>}</For>
							</select>
						</label>
						<label>
							{t("webDev.rpcParameters")}
							<textarea
								value={params()}
								onInput={(event) => setParams(event.currentTarget.value)}
							/>
						</label>
						<button type="button" disabled={!channel()} onClick={() => void invokeRaw()}>
							{t("webDev.invokeHost")}
						</button>
					</section>
					<Show when={error()}>{(message) => <p class="web-dev-debug-error">{message()}</p>}</Show>
					<Show when={output()}>{(value) => <pre role="status">{value()}</pre>}</Show>
				</aside>
			</Show>
		</>
	);
}
