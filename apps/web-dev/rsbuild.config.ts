import { defineConfig, type ProxyOptions } from "@rsbuild/core";
import { pluginBabel } from "@rsbuild/plugin-babel";
import { pluginSolid } from "@rsbuild/plugin-solid";
import { pluginTailwindcss } from "@rsbuild/plugin-tailwindcss";

const hostTarget = `http://127.0.0.1:${process.env.BEAR_WEB_DEV_HOST_PORT ?? "3201"}`;
const hostProxy: ProxyOptions = {
	target: hostTarget,
	plugins: [
		(proxy) => {
			// Rsbuild's logger drops HPM's interpolation arguments. Keep the
			// socket error code without logging request URLs, headers, or bodies.
			// A plugin preserves HPM's default error response handler.
			proxy.on("error", (error) => {
				const code = "code" in error ? error.code : undefined;
				console.error(
					`[web-dev proxy failure] code=${typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "unknown"}`,
				);
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
