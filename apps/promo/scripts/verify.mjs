import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, ".local-output");
const timeline = JSON.parse(await readFile(resolve(out, "timeline.json"), "utf8"));
const script = JSON.parse(await readFile(resolve(root, "src/demo/scenario.json"), "utf8"));
const expected =
	"# 夜读角\n带一本想读的书，来坐一会儿。\n\n- 自由参加，不安排轮流自我介绍。\n- 想分享的时候再开口，也可以自己安静读书。\n- 日期：待定。\n- 报名方式：待定。\n";
await mkdir(resolve(out, "verification"), { recursive: true });
const browser = await chromium.launch({
	headless: true,
	args: ["--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({
	viewport: { width: 1920, height: 1080 },
	deviceScaleFactor: 1,
	locale: "zh-CN",
	timezoneId: "UTC",
	acceptDownloads: true,
});
const faults = [];
const downloads = [];
await context.route("**/*", (route) => {
	const url = new URL(route.request().url());
	if (["http:", "https:"].includes(url.protocol) && url.origin !== "http://127.0.0.1:3266") {
		faults.push(`external ${url.origin}`);
		return route.abort();
	}
	return route.continue();
});
const page = await context.newPage();
page.on("pageerror", (error) => faults.push(error.message));
page.on("console", (message) => {
	if (message.type() === "error") faults.push(message.text());
});
page.on("response", (response) => {
	if (response.status() >= 400) faults.push(`HTTP ${response.status()} ${response.url()}`);
});
page.on("download", (download) => downloads.push(download));
const checks = [];
async function open() {
	await page.goto("http://127.0.0.1:3266/");
	await page.evaluate(async () => {
		await window.promo.ready;
	});
}
async function inspect() {
	return page.evaluate(() => {
		const frame = document.querySelector("iframe");
		const d = frame.contentDocument;
		const state = window.promo.inspect();
		return {
			state,
			body: d.body.innerText,
			dialogs: [...d.querySelectorAll("[role=dialog]")].map((x) => x.getAttribute("aria-label")),
			artifact:
				d.querySelector("[data-artifact-preview]")?.getAttribute("data-artifact-preview") ?? null,
			scroll: Math.round(frame.contentWindow.scrollY),
			caption: document.querySelector(".promo-caption-safe")?.textContent ?? "",
		};
	});
}
try {
	await open();
	await page.evaluate(() => window.promo.play());
	for (const scene of timeline.scenes) {
		const target =
			scene.id === 3 || scene.id === 7
				? scene.actionStart + 1
				: scene.id === 11
					? scene.start + 3
					: scene.id === 12
						? scene.start + 3
						: Math.min(scene.end - 0.4, scene.responseEnd + Math.min(4, scene.readingSeconds / 2));
		await page.waitForFunction((t) => window.promo.inspect().time >= t, target, { timeout: 45000 });
		const result = await inspect();
		assert.equal(result.state.demo.fault, null);
		assert.equal(result.state.sceneId, scene.id);
		const expectedScene = script.find((item) => item.id === scene.id);
		if (expectedScene.assistant && ![3, 7, 11, 12].includes(scene.id))
			assert(result.body.replace(/\s/g, "").includes(expectedScene.assistant.replace(/\s/g, "")));
		await page.screenshot({ path: resolve(out, `verification/play-scene-${scene.id}.png`) });
		checks.push({
			kind: "normal-play",
			scene: scene.id,
			time: result.state.time,
			character: result.state.demo.characterId,
			conversation: result.state.demo.activeConversationId,
			artifact: result.artifact,
			caption: result.caption,
		});
		console.log(`normal scene ${scene.id} @${result.state.time.toFixed(3)}`);
	}
	await page.waitForFunction(
		() => window.promo.inspect().time >= window.promo.duration - 0.05,
		undefined,
		{ timeout: Math.ceil(timeline.duration * 1000) },
	);
	assert.equal(faults.length, 0, JSON.stringify(faults));
	assert(downloads.length >= 1, "normal play must execute actual Web download");
	const downloaded = await readFile(await downloads[0].path(), "utf8");
	assert.equal(downloaded, expected);
	const paths = [];
	for (const id of [3, 8, 10, 11]) {
		const scene = timeline.scenes.find((item) => item.id === id);
		const target =
			id === 3 ? scene.actionStart + 1 : id === 11 ? scene.start + 4 : scene.responseEnd + 3;
		await open();
		await page.evaluate(async (time) => {
			await window.promo.seek(time);
		}, target);
		const direct = await inspect();
		await page.screenshot({ path: resolve(out, `verification/seek-${id}-direct.png`) });
		await page.evaluate(async (time) => {
			await window.promo.seek(window.promo.duration);
			await window.promo.seek(time);
		}, target);
		const backward = await inspect();
		await page.screenshot({ path: resolve(out, `verification/seek-${id}-backward.png`) });
		await page.evaluate(async (time) => {
			await window.promo.seek(0);
			for (let t = 1; t < time; t += 1) await window.promo.seek(t);
			await window.promo.seek(time);
		}, target);
		const forward = await inspect();
		await page.screenshot({ path: resolve(out, `verification/seek-${id}-forward.png`) });
		const projection = (value) => ({
			body: value.body,
			dialogs: value.dialogs,
			artifact: value.artifact,
			caption: value.caption,
			character: value.state.demo.characterId,
			conversation: value.state.demo.activeConversationId,
			memory: value.state.demo.memorySaved,
			run: value.state.demo.runStatus,
			scroll: value.scroll,
		});
		const a = projection(direct),
			b = projection(backward),
			c = projection(forward);
		await writeFile(
			resolve(out, `verification/seek-${id}.json`),
			JSON.stringify({ target, direct: a, backward: b, forward: c }, null, 2),
		);
		assert.deepEqual(b, a, `backward scene${id}`);
		assert.deepEqual(c, a, `forward scene${id}`);
		paths.push({ scene: id, target, projectionEqual: true });
		console.log(`seek paths scene ${id} equal`);
	}
	assert.equal(faults.length, 0, JSON.stringify(faults));
	await writeFile(
		resolve(out, "browser-verification.json"),
		JSON.stringify(
			{
				duration: timeline.duration,
				viewport: [1920, 1080],
				externalNetworkBlocked: true,
				normalPlayback: true,
				checks,
				paths,
				download: {
					bytes: Buffer.byteLength(downloaded),
					sha256: createHash("sha256").update(downloaded).digest("hex"),
					exact: true,
				},
				faults,
				humanAudioListening: false,
			},
			null,
			2,
		),
	);
	console.log("Full normal playback, native controls, downloaded bytes and seek paths passed");
} finally {
	await browser.close();
}
