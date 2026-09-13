#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, ".local-output");
const output = resolve(out, "bear-harness-slides-1080p.mp4");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];

function launch(command, args, env = process.env) {
	const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
	child.log = "";
	child.stderr.on("data", (data) => {
		child.log = (child.log + data.toString()).slice(-10000);
	});
	child.stdout.on("data", () => {});
	child.finished = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code));
	});
	children.push(child);
	return child;
}

async function waitUntil(check, description, timeout = 30000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await check();
		if (value) return value;
		await sleep(100);
	}
	throw new Error(`Timed out: ${description}`);
}

async function main() {
	await mkdir(out, { recursive: true });
	const timeline = JSON.parse(await readFile(resolve(out, "timeline.json"), "utf8"));
	const profile = await mkdtemp(resolve(out, ".gpu-profile-"));
	const raw = resolve(out, "gpu-capture.mkv");
	const temporary = resolve(out, ".slides-gpu-final.mp4");
	let browser;
	let display = 95;
	while (existsSync(`/tmp/.X11-unix/X${display}`)) display++;
	try {
		await mkdir(resolve(profile, "Default"));
		await writeFile(
			resolve(profile, "Default/Preferences"),
			JSON.stringify({ translate: { enabled: false }, intl: { accept_languages: "zh-CN,zh" } }),
		);
		const x = launch("Xvfb", [
			`:${display}`,
			"-screen",
			"0",
			"1920x1080x24",
			"-nolisten",
			"tcp",
			"-ac",
		]);
		await waitUntil(() => {
			if (x.exitCode !== null) throw new Error(x.log);
			return existsSync(`/tmp/.X11-unix/X${display}`);
		}, "isolated X11 display");
		const chrome = launch(
			"/usr/bin/chromium",
			[
				"--no-sandbox",
				"--ozone-platform=x11",
				"--remote-debugging-port=0",
				`--user-data-dir=${profile}`,
				"--use-gl=angle",
				"--use-angle=vulkan",
				"--enable-features=Vulkan",
				"--disable-vulkan-surface",
				"--enable-gpu-rasterization",
				"--ignore-gpu-blocklist",
				"--disable-software-rasterizer",
				"--disable-features=Translate,TranslateUI",
				"--lang=zh-CN",
				"--autoplay-policy=no-user-gesture-required",
				"--mute-audio",
				"--no-first-run",
				"--no-default-browser-check",
				"--force-device-scale-factor=1",
				"--window-size=1920,1080",
				"--window-position=0,0",
				"--kiosk",
				"http://127.0.0.1:3266/?capture=1",
			],
			{ ...process.env, DISPLAY: `:${display}` },
		);
		await waitUntil(() => {
			if (chrome.exitCode !== null) throw new Error(chrome.log);
			return existsSync(resolve(profile, "DevToolsActivePort"));
		}, "Chromium debugging endpoint");
		const port = (await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		const page = browser.contexts()[0].pages()[0];
		await page.waitForFunction(() => Boolean(window.promo));
		await page.evaluate(() => window.promo.ready);
		await page.waitForFunction(
			() =>
				screen.width === 1920 && screen.height === 1080 && innerWidth > 1900 && innerHeight > 1060,
		);
		const cdp = await browser.newBrowserCDPSession();
		const info = await cdp.send("SystemInfo.getInfo");
		const renderer = info.gpu.auxAttributes.glRenderer;
		if (!renderer.includes("NVIDIA") || info.gpu.featureStatus.gpu_compositing !== "enabled") {
			throw new Error(`Hardware rendering unavailable: ${renderer}`);
		}
		console.log(`GPU renderer: ${renderer}`);
		await writeFile(resolve(out, "gpu-renderer.json"), JSON.stringify(info.gpu, null, 2));
		await page.evaluate(() => window.promo.seek(0));

		// x11grab continuously captures the isolated display. No screenshot loop.
		const recorder = launch("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"info",
			"-debug_ts",
			"-y",
			"-f",
			"x11grab",
			"-framerate",
			"30",
			"-video_size",
			"1920x1080",
			"-draw_mouse",
			"0",
			"-i",
			`:${display}.0`,
			"-an",
			"-vf",
			"scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p",
			"-c:v",
			"h264_nvenc",
			"-preset",
			"p4",
			"-rc",
			"vbr",
			"-cq",
			"16",
			"-b:v",
			"0",
			"-color_range",
			"tv",
			"-colorspace",
			"bt709",
			"-color_primaries",
			"bt709",
			"-color_trc",
			"bt709",
			"-fps_mode",
			"cfr",
			raw,
		]);
		let firstPacket;
		let packetLog = "";
		recorder.stderr.on("data", (chunk) => {
			if (firstPacket !== undefined) return;
			packetLog = (packetLog + chunk.toString()).slice(-20000);
			const match = packetLog.match(/demuxer ->[^\n]*?pkt_pts:(\d+)/);
			if (match) firstPacket = Number(match[1]) / 1000000;
		});
		await waitUntil(() => {
			if (recorder.exitCode !== null) throw new Error(recorder.log);
			return firstPacket !== undefined;
		}, "first captured video frame");
		const started = await page.evaluate(async () => {
			const audio = document.querySelector("audio");
			const playing = new Promise((resolve) =>
				audio.addEventListener(
					"playing",
					() => {
						resolve({ epoch: Date.now() / 1000 - audio.currentTime });
					},
					{ once: true },
				),
			);
			window.promo.play();
			return playing;
		});
		const offset = Math.max(0, started.epoch - firstPacket);
		console.log(
			`Recording continuous GPU video; duration=${timeline.duration}s, preroll=${offset.toFixed(3)}s`,
		);
		let lastSlide;
		const progress = setInterval(async () => {
			try {
				const state = await page.evaluate(() => ({
					time: window.promo.inspect().time,
					page: document.querySelector("[data-page]").getAttribute("data-page"),
				}));
				if (state.page !== lastSlide) {
					lastSlide = state.page;
					console.log(`Recording slide ${state.page}/9 at ${state.time.toFixed(1)}s`);
				}
			} catch {
				/* Main wait below reports page failures. */
			}
		}, 1000);
		try {
			await page.waitForFunction(
				() =>
					document.querySelector("audio").ended ||
					window.promo.inspect().time >= window.promo.duration - 0.02,
				undefined,
				{ timeout: (timeline.duration + 30) * 1000 },
			);
		} finally {
			clearInterval(progress);
		}
		await sleep(400);
		recorder.stdin.write("q\n");
		if ((await recorder.finished) !== 0) throw new Error(recorder.log);
		console.log("Recording complete; trimming preroll and muxing original narration with NVENC");
		const encoder = launch("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-ss",
			offset.toFixed(6),
			"-i",
			raw,
			"-i",
			resolve(out, "narration.wav"),
			"-map",
			"0:v:0",
			"-map",
			"1:a:0",
			"-t",
			String(timeline.duration),
			"-c:v",
			"h264_nvenc",
			"-preset",
			"p4",
			"-rc",
			"vbr",
			"-cq",
			"19",
			"-b:v",
			"0",
			"-pix_fmt",
			"yuv420p",
			"-r",
			"30",
			"-fps_mode",
			"cfr",
			"-color_range",
			"tv",
			"-colorspace",
			"bt709",
			"-color_primaries",
			"bt709",
			"-color_trc",
			"bt709",
			"-c:a",
			"aac",
			"-b:a",
			"192k",
			"-movflags",
			"+faststart",
			temporary,
		]);
		if ((await encoder.finished) !== 0) throw new Error(encoder.log);
		await rename(temporary, output);
		await writeFile(
			resolve(out, "gpu-recording.json"),
			JSON.stringify(
				{
					renderer,
					capture: "continuous x11grab on isolated Xvfb display",
					encoder: "h264_nvenc",
					fps: 30,
					width: 1920,
					height: 1080,
					duration: timeline.duration,
					preroll: offset,
					firstPacketEpoch: firstPacket,
					playbackEpoch: started.epoch,
					humanListeningReview: false,
					output,
				},
				null,
				2,
			),
		);
		console.log(`Wrote ${output}`);
	} finally {
		if (browser) await browser.close().catch(() => {});
		for (const child of children.reverse()) {
			if (child.exitCode === null) {
				child.kill("SIGTERM");
				await Promise.race([child.finished.catch(() => {}), sleep(2000)]);
				if (child.exitCode === null) child.kill("SIGKILL");
			}
		}
		await rm(profile, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error.stack ?? error);
	process.exitCode = 1;
});
