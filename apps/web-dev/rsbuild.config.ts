import { defineConfig, type ProxyOptions } from "@rsbuild/core";
import { pluginBabel } from "@rsbuild/plugin-babel";
import { pluginSolid } from "@rsbuild/plugin-solid";
import { pluginTailwindcss } from "@rsbuild/plugin-tailwindcss";
import { observeProxyFailure } from "./scripts/proxy-failure.mjs";

const hostTarget = `http://127.0.0.1:${process.env.BEAR_WEB_DEV_HOST_PORT ?? "3201"}`;
const soak = Number(process.env.BEAR_E2E_SOAK_MINUTES ?? "0") > 0;
const hostProxy: ProxyOptions = {
	target: hostTarget,
	plugins: [
		(proxy) => {
			// Rsbuild's logger drops HPM's interpolation arguments. Keep the
			// bounded socket error code and fixed route category without logging
			// request URLs, headers, query strings, or bodies.
			// A plugin preserves HPM's default error response handler.
			proxy.on("error", (error, request, response) => {
				const observation = observeProxyFailure(error, request, response);
				if (observation.clientAborted) return;
				console.error(
					`[web-dev proxy failure] route=${observation.route} code=${observation.code}`,
				);
				if (soak) queueMicrotask(() => process.exit(1));
			});
		},
	],
};

export default defineConfig({
	plugins: [pluginBabel({ include: /\.(?:jsx|tsx)$/ }), pluginSolid(), pluginTailwindcss()],
	tools: {
		rspack: (config) => {
			config.resolve ??= {};
			config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
			return config;
		},
	},
	source: {
		entry: { index: "./src/index.tsx" },
	},
	html: {
		template: "./index.html",
	},
	server: {
		host: "127.0.0.1",
		port: Number(process.env.BEAR_WEB_DEV_PORT ?? "3200"),
		strictPort: true,
		proxy: {
			"/bootstrap": hostProxy,
			"/rpc": hostProxy,
			"/events": hostProxy,
			"/attachment": hostProxy,
			"/diagnostics": hostProxy,
			"/debug": hostProxy,
		},
	},
	output: {
		distPath: { root: "dist" },
	},
});
