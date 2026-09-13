import "./check-copy.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, ".local-output");
const probe = process.argv.includes("--check-gpu");
await mkdir(out, { recursive: true });
// Generated narration must match the current source before previewing.
if (!probe) {
	const slides = JSON.parse(await readFile(resolve(root, "src/demo/slides.json"), "utf8"));
	const timeline = JSON.parse(await readFile(resolve(out, "timeline.json"), "utf8"));
	for (const slide of slides) {
		const text = timeline.captions
			.filter((cue) => cue.slideId === slide.id)
			.map((cue) => cue.text)
			.join("");
		if (text !== slide.narration)
			throw new Error("Regenerate narration and subtitles before opening promo");
	}
}
const profile = await mkdtemp(resolve(out, ".native-profile-"));
let server;
let context;
let closing;
function close() {
	closing ??= (async () => {
		await context?.close();
		await server?.close();
		await rm(profile, { recursive: true, force: true });
	})();
	return closing;
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
try {
	if (!probe) {
		server = await createServer({ root, configFile: resolve(root, "vite.config.ts") });
		await server.listen();
	}
	const url = probe ? "about:blank" : "http://127.0.0.1:3266/";
	context = await chromium.launchPersistentContext(profile, {
		executablePath: process.env.PROMO_CHROMIUM ?? "/usr/bin/chromium",
		headless: false,
		viewport: null,
		args: [`--app=${url}`, "--window-size=1920,1080", "--autoplay-policy=no-user-gesture-required"],
	});
	const page = context.pages()[0] ?? (await context.newPage());
	await page.goto(url);
	if (!probe) {
		await page.waitForFunction(() => Boolean(window.promo));
		await page.evaluate(() => window.promo.ready);
	}
	const cdp = await context.browser().newBrowserCDPSession();
	const { gpu } = await cdp.send("SystemInfo.getInfo");
	const renderer = gpu.auxAttributes?.glRenderer ?? "";
	await writeFile(resolve(out, "native-gpu.json"), JSON.stringify(gpu, null, 2));
	if (
		!renderer ||
		/swiftshader|llvmpipe|softpipe|software/i.test(renderer) ||
		gpu.featureStatus.gpu_compositing !== "enabled"
	) {
		throw new Error(`Hardware GPU compositing unavailable: ${renderer}`);
	}
	console.log(`Native GPU promo ready: ${renderer}`);
	if (!probe) {
		console.log("http://127.0.0.1:3266/ — close the promo window to stop");
		await new Promise((done) => context.once("close", done));
	}
} finally {
	await close();
}
