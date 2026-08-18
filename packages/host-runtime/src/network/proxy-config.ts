import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import type { SystemProxy } from "./system-proxy.js";
import { resolveSystemProxy } from "./system-proxy.js";

/**
 * Product network proxy configuration. The default is direct — nothing is
 * injected until the user (or an environment) opts in.
 */
export interface NetworkProxyConfig {
	readonly mode: "direct" | "auto" | "manual";
	/** Manual proxy URL, e.g. http://127.0.0.1:7890 (manual mode only). */
	readonly url?: string;
	/** Extra bypass hosts for manual mode (localhost is always bypassed). */
	readonly bypass?: string[];
}

interface Logger {
	debug?: (message: string) => void;
	warn: (message: string) => void;
}

const DEFAULT_BYPASS = "localhost,127.0.0.1,::1";

/**
 * Optional host-provided resolver (Electron main): uses Chromium's network
 * stack (session.resolveProxy) which understands PAC/WPAD and all three OS
 * proxy settings. Host runtimes that run inside Electron pass this in.
 */
export type SystemProxyResolver = (targetUrl: string) => Promise<string | "DIRECT">;

function bypassList(config: NetworkProxyConfig, system?: SystemProxy): string {
	const parts = [DEFAULT_BYPASS];
	if (system?.bypass && system.bypass.length > 0) parts.push(system.bypass.join(","));
	if (config.bypass && config.bypass.length > 0) parts.push(config.bypass.join(","));
	return parts.join(",");
}

/**
 * Apply the network proxy configuration to the global undici dispatcher.
 *
 * Every network call the host makes (LLM SDKs, TdaiCore embedding, pi-ai)
 * goes through the global fetch dispatcher, so a single injection covers all
 * of them. "direct" leaves the default dispatcher untouched.
 *
 * @param resolve Optional host resolver (Electron session.resolveProxy).
 * @param systemResolver Direct platform resolution override (tests).
 */
export async function applyProxyConfig(
	config: NetworkProxyConfig,
	options: {
		resolve?: SystemProxyResolver;
		systemProxy?: () => Promise<SystemProxy | undefined>;
		logger?: Logger;
	} = {},
): Promise<void> {
	if (config.mode === "direct") return;

	const systemProxyResolver = options.systemProxy ?? (() => resolveSystemProxy(options.logger));
	const resolve = options.resolve;

	if (config.mode === "manual") {
		if (!config.url) throw new Error("manual proxy mode requires a proxy URL");
		setGlobalDispatcher(
			new EnvHttpProxyAgent({
				httpProxy: config.url,
				httpsProxy: config.url,
				noProxy: bypassList(config),
			}),
		);
		return;
	}

	// auto: Electron resolver (PAC-aware) → OS platform resolver → env vars.
	let system: SystemProxy | undefined;
	if (resolve) {
		try {
			const result = await resolve("https://example.com");
			if (result !== "DIRECT" && result.length > 0) {
				const url = result.startsWith("http") ? result : `http://${result}`;
				system = { url, source: "linux", bypass: [] };
			}
		} catch (error) {
			options.logger?.debug?.(`electron proxy resolve failed: ${String(error)}`);
		}
	}
	if (!system) system = await systemProxyResolver().catch(() => undefined);

	if (system?.url) {
		setGlobalDispatcher(
			new EnvHttpProxyAgent({
				httpProxy: system.url,
				httpsProxy: system.url,
				noProxy: bypassList(config, system),
			}),
		);
		return;
	}

	// Fall back to pure environment-variable proxy resolution (undici's own
	// behavior): if HTTPS_PROXY/HTTP_PROXY are set they apply, otherwise the
	// default direct dispatcher is reinstated.
	setGlobalDispatcher(new EnvHttpProxyAgent());
}
