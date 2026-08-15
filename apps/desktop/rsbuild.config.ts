/**
 * Rsbuild configuration for the renderer.
 *
 * - Babel for JSX/TSX, Solid plugin, Tailwind v4 plugin.
 * - Entry `src/renderer/index.tsx`, HTML template `src/renderer/index.html`,
 *   output fixed to `dist/renderer` with a relative asset prefix and no
 *   sourcemaps so the packaged app can load via `file://`.
 * - Renderer product identity is injected by the thin desktop entry from
 *   `@bear-harness/product-config`; this config never serializes it.
 * - CSP meta is injected per Rsbuild command mode (development vs production),
 *   never from a runtime NODE_ENV.
 */

import { defineConfig } from "@rsbuild/core";
import { pluginBabel } from "@rsbuild/plugin-babel";
import { pluginSolid } from "@rsbuild/plugin-solid";
import { pluginTailwindcss } from "@rsbuild/plugin-tailwindcss";

const DEV_CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"connect-src 'self' ws://127.0.0.1:3100 http://127.0.0.1:3100",
	"font-src 'self'",
].join("; ");

const PROD_CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"connect-src 'self'",
	"font-src 'self'",
].join("; ");

export default defineConfig(({ command }) => {
	const production = command === "build";
	return {
		plugins: [pluginBabel({ include: /\.(?:jsx|tsx)$/ }), pluginSolid(), pluginTailwindcss()],
		tools: {
			rspack: (config) => {
				// The renderer follows the repo convention of importing TS modules
				// with a `.js` extension (NodeNext-style, used by the main process);
				// map it back so bundling resolves `./stores/companion.js` →
				// `companion.tsx`. Rsbuild's `resolve` config does not expose
				// extensionAlias, so it is set on the raw rspack config here.
				config.resolve ??= {};
				config.resolve.extensionAlias = {
					".js": [".ts", ".tsx", ".js"],
				};
				return config;
			},
		},
		source: {
			entry: {
				index: "./src/renderer/index.tsx",
			},
		},
		html: {
			template: "./src/renderer/index.html",
			tags: [
				{
					tag: "meta",
					attrs: {
						"http-equiv": "Content-Security-Policy",
						content: production ? PROD_CSP : DEV_CSP,
					},
					injectInto: "head",
				},
			],
		},
		output: {
			distPath: {
				root: "dist/renderer",
			},
			assetPrefix: production ? "./" : "/",
			sourceMap: false,
		},
		server: {
			host: "127.0.0.1",
			port: 3100,
			strictPort: true,
		},
	};
});
