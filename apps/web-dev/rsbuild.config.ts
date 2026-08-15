import { defineConfig } from "@rsbuild/core";
import { pluginBabel } from "@rsbuild/plugin-babel";
import { pluginSolid } from "@rsbuild/plugin-solid";
import { pluginTailwindcss } from "@rsbuild/plugin-tailwindcss";

const hostTarget = `http://127.0.0.1:${process.env.BEAR_WEB_DEV_HOST_PORT ?? "3201"}`;

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
		port: 3200,
		strictPort: true,
		proxy: {
			"/bootstrap": hostTarget,
			"/rpc": hostTarget,
			"/diagnostics": hostTarget,
			"/debug": hostTarget,
		},
	},
	output: {
		distPath: { root: "dist" },
	},
});
