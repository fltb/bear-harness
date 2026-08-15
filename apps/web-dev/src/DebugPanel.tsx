import { unwrap } from "@bear-harness/companion-client";
import type { CompanionClient, HostTransport } from "@bear-harness/companion-types";
import { productUi } from "@bear-harness/product-config";
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
			const result = await props.transport.invoke(channel(), parsed);
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
			await unwrap(props.client.provider.setApiKey(providerId(), apiKey(), true));
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
				<aside class="web-dev-debug-panel" aria-label={productUi.webDev.ariaLabel}>
					<header>
						<strong>{productUi.webDev.title}</strong>
						<button type="button" onClick={toggle} aria-label={productUi.webDev.close}>
							{productUi.webDev.close}
						</button>
					</header>
					<p>{productUi.webDev.description}</p>
					<section>
						<h2>{productUi.webDev.providerSection}</h2>
						<button type="button" onClick={() => void loadProviders()}>
							{productUi.webDev.loadProviders}
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
								{productUi.webDev.sessionApiKey}
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
								{productUi.webDev.saveSessionKey}
							</button>
						</Show>
					</section>
					<section>
						<h2>{productUi.webDev.rpcSection}</h2>
						<label>
							Channel
							<select value={channel()} onChange={(event) => setChannel(event.currentTarget.value)}>
								<For each={channels()}>{(entry) => <option value={entry}>{entry}</option>}</For>
							</select>
						</label>
						<label>
							{productUi.webDev.rpcParameters}
							<textarea
								value={params()}
								onInput={(event) => setParams(event.currentTarget.value)}
							/>
						</label>
						<button type="button" disabled={!channel()} onClick={() => void invokeRaw()}>
							{productUi.webDev.invokeHost}
						</button>
					</section>
					<Show when={error()}>{(message) => <p class="web-dev-debug-error">{message()}</p>}</Show>
					<Show when={output()}>{(value) => <pre role="status">{value()}</pre>}</Show>
				</aside>
			</Show>
		</>
	);
}
