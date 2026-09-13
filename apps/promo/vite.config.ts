import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const root = import.meta.dirname;
const content = resolve(root, ".local-content");
const output = resolve(root, ".local-output");
const mime: Record<string, string> = {
	png: "image/png",
	webp: "image/webp",
	jpg: "image/jpeg",
	json: "application/json",
	wav: "audio/wav",
	mp3: "audio/mpeg",
	mp4: "video/mp4",
	srt: "application/x-subrip",
	vtt: "text/vtt",
	woff2: "font/woff2",
};

export default defineConfig({
	plugins: [
		solid(),
		tailwind(),
		{
			name: "private-production-content",
			configureServer(server) {
				const manifestPath = resolve(content, "media-manifest.json");
				if (!existsSync(manifestPath))
					throw new Error(`Missing frozen media manifest: ${manifestPath}`);
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
				const failures: string[] = [];
				for (const entry of Object.values(manifest.files) as { url: string; sha256: string }[]) {
					const file = resolve(content, entry.url);
					if (!file.startsWith(content + sep) || !existsSync(file))
						failures.push(`missing ${entry.url}`);
					else if (createHash("sha256").update(readFileSync(file)).digest("hex") !== entry.sha256)
						failures.push(`hash mismatch ${entry.url}`);
				}
				if (failures.length) throw new Error(`Frozen media unavailable:\n${failures.join("\n")}`);
				server.middlewares.use((req, res, next) => {
					const url = new URL(req.url ?? "/", "http://127.0.0.1");
					const base = url.pathname.startsWith("/local-content/")
						? content
						: url.pathname.startsWith("/local-output/")
							? output
							: null;
					if (!base) return next();
					let suffix: string;
					try {
						suffix = decodeURIComponent(url.pathname).split("/").slice(2).join("/");
					} catch {
						res.statusCode = 400;
						res.end();
						return;
					}
					const file = resolve(base, suffix);
					if (!file.startsWith(base + sep) || !existsSync(file)) {
						res.statusCode = 404;
						res.end(`Missing private production file: ${suffix}`);
						return;
					}
					res.setHeader(
						"Content-Type",
						mime[file.split(".").pop() ?? ""] ?? "application/octet-stream",
					);
					res.setHeader("Cache-Control", "no-store");
					const size = statSync(file).size;
					let start = 0;
					let end = size - 1;
					res.setHeader("Accept-Ranges", "bytes");
					if (req.headers.range) {
						const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
						if (!match) {
							res.statusCode = 416;
							res.end();
							return;
						}
						start = Number(match[1]);
						end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
						if (start > end || start >= size) {
							res.statusCode = 416;
							res.setHeader("Content-Range", `bytes */${size}`);
							res.end();
							return;
						}
						res.statusCode = 206;
						res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
					}
					res.setHeader("Content-Length", end - start + 1);
					if (req.method === "HEAD") {
						res.end();
						return;
					}
					createReadStream(file, { start, end })
						.on("error", () => {
							res.destroy();
						})
						.pipe(res);
				});
			},
		},
	],
	server: {
		host: "127.0.0.1",
		port: 3266,
		strictPort: true,
		hmr: false,
		watch: { ignored: ["**/.local-content/**", "**/.local-output/**"] },
	},
	publicDir: false,
	resolve: { dedupe: ["solid-js"] },
	build: {
		rollupOptions: {
			input: { main: resolve(root, "index.html"), renderer: resolve(root, "renderer.html") },
		},
	},
});
