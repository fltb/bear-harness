export type PromoPhase = "enter" | "input" | "response" | "settled" | "action" | "exit";
type DemoPhase = PromoPhase | "close";

export interface PromoScene {
	id: number;
	title: string;
	user: string;
	assistant: string;
	narration: string;
	narrationPlacement: "before" | "after" | "none";
	actions: string[];
	readingSeconds: number;
}

export interface TimelineScene {
	id: number;
	start: number;
	end: number;
	inputStart: number;
	responseStart: number;
	responseEnd: number;
	narrationStart: number | null;
	narrationEnd: number | null;
	actionStart: number;
	closeAt?: number;
	exitAt?: number;
}

export interface PromoTimeline {
	duration: number;
	scenes: TimelineScene[];
	captions: Array<{ start: number; end: number; text: string }>;
}

export interface PromoState {
	time: number;
	duration: number;
	sceneId: number | null;
	phase: PromoPhase | "idle" | "complete";
	caption: string;
	playing: boolean;
	debug: boolean;
	cursor: { x: number; y: number; clicking: boolean };
	cameraScale: number;
	cameraX: number;
	cameraY: number;
	label: string;
	callouts: string[];
}

interface DemoWindow {
	demo?: {
		ready: Promise<void>;
		advance(sceneId: number, phase: string, progress?: number): Promise<void>;
		inspect(): unknown;
		dispose(): void;
	};
}

export interface PromoDirectorOptions {
	iframe: HTMLIFrameElement;
	audio: HTMLAudioElement;
	record: boolean;
	debug: boolean;
	onState(state: PromoState): void;
	onError(error: Error): void;
}

export interface PromoDirector {
	readonly ready: Promise<void>;
	readonly duration: number;
	seek(seconds: number): Promise<void>;
	play(): void;
	pause(): void;
	replay(): Promise<void>;
	dispose(): void;
	inspect(): unknown;
}

const FRAME_TIMEOUT_MS = 20_000;

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function assertTimeline(value: unknown): PromoTimeline {
	if (!value || typeof value !== "object") throw new Error("timeline.json is not an object");
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.duration !== "number" ||
		!Number.isFinite(candidate.duration) ||
		candidate.duration <= 0
	) {
		throw new Error("timeline.json has an invalid duration");
	}
	if (!Array.isArray(candidate.scenes) || !Array.isArray(candidate.captions)) {
		throw new Error("timeline.json must contain scenes and captions arrays");
	}
	if (candidate.scenes.length !== 13)
		throw new Error(`timeline.json must contain 13 scenes, received ${candidate.scenes.length}`);
	const scenes = candidate.scenes.map((raw, index) => {
		if (!raw || typeof raw !== "object") throw new Error(`timeline scene ${index} is invalid`);
		const scene = raw as Record<string, unknown>;
		const keys = [
			"id",
			"start",
			"end",
			"inputStart",
			"responseStart",
			"responseEnd",
			"actionStart",
		];
		for (const key of keys) {
			if (typeof scene[key] !== "number" || !Number.isFinite(scene[key]))
				throw new Error(`timeline scene ${index} has invalid ${key}`);
		}
		if (!Number.isInteger(scene.id) || Number(scene.id) < 0 || Number(scene.id) > 12)
			throw new Error(`timeline scene ${index} has invalid id`);
		for (const key of ["narrationStart", "narrationEnd"]) {
			if (scene[key] !== null && (typeof scene[key] !== "number" || !Number.isFinite(scene[key])))
				throw new Error(`timeline scene ${index} has invalid ${key}`);
		}
		for (const key of ["closeAt", "exitAt"]) {
			if (
				scene[key] !== undefined &&
				(typeof scene[key] !== "number" || !Number.isFinite(scene[key]))
			)
				throw new Error(`timeline scene ${index} has invalid ${key}`);
		}
		if (Number(scene.end) < Number(scene.start))
			throw new Error(`timeline scene ${index} has reversed bounds`);
		if (scene.closeAt !== undefined && scene.id !== 3)
			throw new Error(`timeline scene ${index} closeAt is only supported for scene 3`);
		if (scene.closeAt !== undefined && Number(scene.closeAt) < Number(scene.actionStart))
			throw new Error(`timeline scene ${index} closeAt precedes actionStart`);
		if (scene.closeAt !== undefined && Number(scene.closeAt) > Number(scene.end))
			throw new Error(`timeline scene ${index} closeAt exceeds scene end`);
		if (scene.exitAt !== undefined && Number(scene.exitAt) < Number(scene.actionStart))
			throw new Error(`timeline scene ${index} exitAt precedes actionStart`);
		if (scene.exitAt !== undefined && Number(scene.exitAt) > Number(scene.end))
			throw new Error(`timeline scene ${index} exitAt exceeds scene end`);
		if (
			scene.closeAt !== undefined &&
			Number(scene.exitAt ?? scene.closeAt) < Number(scene.closeAt)
		)
			throw new Error(`timeline scene ${index} exitAt precedes closeAt`);
		return scene as unknown as TimelineScene;
	});
	const ids = scenes.map((scene) => scene.id);
	if (new Set(ids).size !== 13 || ids.some((id, index) => id !== index))
		throw new Error("timeline scenes must contain contiguous ids 0 through 12");
	const captions = candidate.captions.map((raw, index) => {
		if (!raw || typeof raw !== "object") throw new Error(`caption ${index + 1} is invalid`);
		const caption = raw as Record<string, unknown>;
		if (
			typeof caption.start !== "number" ||
			!Number.isFinite(caption.start) ||
			typeof caption.end !== "number" ||
			!Number.isFinite(caption.end) ||
			caption.end < caption.start ||
			typeof caption.text !== "string"
		) {
			throw new Error(`caption ${index + 1} is invalid`);
		}
		return { start: caption.start, end: caption.end, text: caption.text };
	});
	return { duration: Number(candidate.duration), scenes, captions };
}

function captionAt(timeline: PromoTimeline, time: number): string {
	const caption = timeline.captions.find((item) => time >= item.start && time < item.end);
	return caption?.text ?? "";
}

function sceneAt(timeline: PromoTimeline, time: number): TimelineScene | undefined {
	return (
		timeline.scenes.find((scene) => time >= scene.start && time < scene.end) ??
		timeline.scenes.at(-1)
	);
}

function phaseProgress(time: number, start: number, end: number): number {
	if (end <= start) return time >= end ? 1 : 0;
	return Math.max(0, Math.min(1, (time - start) / (end - start)));
}

export function createPromoDirector(options: PromoDirectorOptions): PromoDirector {
	const { iframe, audio, record, debug, onState, onError } = options;
	let timeline: PromoTimeline | undefined;
	let current = 0;
	let playing = false;
	let disposed = false;
	let busy = false;
	let desired: number | undefined;
	let generation = 0;
	let frameHandle = 0;
	let state: PromoState = {
		time: 0,
		duration: 0,
		sceneId: null,
		phase: "idle",
		caption: "",
		playing: false,
		debug,
		cameraX: 0,
		cameraY: 0,
		cursor: { x: 960, y: 570, clicking: false },
		cameraScale: 1,
		label: "",
		callouts: [],
	};
	const phaseMarks = new Map<string, number>();
	const waiting: Array<{ resolve: () => void; reject: (reason: unknown) => void }> = [];
	const publish = (next: Partial<PromoState>) => {
		state = { ...state, ...next };
		onState(state);
	};

	const frameReady = async (): Promise<void> => {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = window.setTimeout(
			() => reject(new Error("renderer iframe did not load in time")),
			FRAME_TIMEOUT_MS,
		);
		const finish = () => {
			window.clearTimeout(timer);
			resolve();
		};
		iframe.addEventListener("load", finish, { once: true });
		return promise;
	};

	const waitForAudio = (): Promise<void> => {
		if (record) return Promise.resolve();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
			resolve();
			return promise;
		}
		const onLoaded = () => {
			cleanup();
			resolve();
		};
		const onErrorEvent = () => {
			cleanup();
			reject(new Error("/local-output/narration.wav could not be decoded"));
		};
		const cleanup = () => {
			audio.removeEventListener("loadedmetadata", onLoaded);
			audio.removeEventListener("error", onErrorEvent);
		};
		audio.addEventListener("loadedmetadata", onLoaded, { once: true });
		audio.addEventListener("error", onErrorEvent, { once: true });
		return promise;
	};

	const getDemo = (): NonNullable<DemoWindow["demo"]> => {
		const demo = (iframe.contentWindow as DemoWindow | null)?.demo;
		if (!demo) throw new Error("renderer iframe did not expose window.demo");
		return demo;
	};

	const waitForAssets = async () => {
		await document.fonts.ready;
		if (document.fonts.status !== "loaded") throw new Error("outer promo fonts failed to load");
		const frameFonts = iframe.contentDocument?.fonts;
		await (frameFonts?.ready ?? Promise.resolve());
		if (frameFonts && frameFonts.status !== "loaded")
			throw new Error("renderer fonts failed to load");
		const images = [...(iframe.contentDocument?.images ?? [])];
		await Promise.all(
			images.map(async (image) => {
				if (image.complete) {
					if (image.naturalWidth === 0)
						throw new Error(`renderer asset failed: ${image.currentSrc || image.src}`);
					await image.decode();
					return;
				}
				const { promise, resolve, reject } = Promise.withResolvers<void>();
				image.addEventListener("load", () => resolve(), { once: true });
				image.addEventListener(
					"error",
					() => reject(new Error(`renderer asset failed: ${image.currentSrc || image.src}`)),
					{ once: true },
				);
				await promise;
				await image.decode();
			}),
		);
	};

	const stabilizeRendererAnimations = () => {
		for (const animation of iframe.contentDocument?.getAnimations() ?? []) {
			const end = animation.effect?.getComputedTiming().endTime;
			animation.pause();
			if (typeof end === "number" && Number.isFinite(end)) animation.currentTime = end;
		}
	};

	const loadFrame = async () => {
		const token = ++generation;
		const loaded = frameReady();
		iframe.src = `/renderer.html?record=${record ? "1" : "0"}&generation=${token}`;
		await loaded;
		const demo = getDemo();
		await demo.ready;
		await waitForAssets();
		stabilizeRendererAnimations();
		if (token !== generation) throw new Error("renderer was rebuilt during initialization");
	};
	const invokePhase = async (scene: TimelineScene, phase: DemoPhase, progress?: number) => {
		if (disposed) return;
		const demo = getDemo();
		try {
			await demo.advance(scene.id, phase, progress);
			await waitForAssets();
			stabilizeRendererAnimations();
		} catch (error) {
			throw new Error(`scene ${scene.id} ${phase} failed: ${asError(error).message}`);
		}
	};

	const phaseKey = (scene: TimelineScene, phase: DemoPhase) => `${scene.id}:${phase}`;

	const invokeOnce = async (scene: TimelineScene, phase: PromoPhase) => {
		const key = phaseKey(scene, phase);
		if (phaseMarks.has(key)) return;
		await invokePhase(scene, phase);
		phaseMarks.set(key, 1);
	};

	const invokeClose = async (scene: TimelineScene) => {
		const key = phaseKey(scene, "close");
		if (phaseMarks.has(key)) return;
		await invokePhase(scene, "close");
		phaseMarks.set(key, 1);
	};

	const invokeProgressively = async (scene: TimelineScene, phase: PromoPhase, progress: number) => {
		const key = phaseKey(scene, phase);
		const previous = phaseMarks.get(key) ?? -1;
		if ((progress < 1 && progress <= previous + 0.005) || (progress === 1 && previous === 1))
			return;
		await invokePhase(scene, phase, progress);
		phaseMarks.set(key, progress);
	};
	const phaseAt = (scene: TimelineScene, time: number): PromoState["phase"] => {
		if (time < scene.inputStart) return "enter";
		if (time < scene.responseStart) return "input";
		if (time < scene.responseEnd) return "response";
		if (time < scene.actionStart) return "settled";
		const exitAt = scene.exitAt ?? ([3, 4, 5].includes(scene.id) ? scene.end - 1.2 : scene.end);
		if (time < exitAt) return "action";
		return "exit";
	};
	const cursorAt = (
		scene: TimelineScene | undefined,
		time: number,
		actionTarget: { x: number; y: number },
		composer: { x: number; y: number },
		send: { x: number; y: number },
	) => {
		if (!scene) return { x: 960, y: 570, clicking: false };
		let from = { x: composer.x - 90, y: composer.y - 30 };
		let to = composer;
		let at = scene.inputStart;
		if (time >= scene.inputStart) {
			from = composer;
			to = send;
			at = scene.responseStart;
		}
		if (time >= scene.responseStart) {
			from = send;
			to = actionTarget;
			at = scene.actionStart;
		}
		const progress = phaseProgress(time, at - 0.45, at);
		const camera = cameraAt(scene, time);
		const localX = from.x + (to.x - from.x) * progress;
		const localY = from.y + (to.y - from.y) * progress;
		return {
			x:
				160 + (1600 - 1600 * camera.cameraScale) / 2 + localX * camera.cameraScale + camera.cameraX,
			y: 170 + localY * camera.cameraScale + camera.cameraY,
			clicking: time >= at && time < at + 0.2,
		};
	};

	const cameraAt = (scene: TimelineScene | undefined, time: number) => {
		if (scene?.id !== 11) return { cameraScale: 1, cameraX: 0, cameraY: 0 };
		const zoomIn = phaseProgress(time, scene.start + 0.5, scene.start + 1.25);
		const zoomOut = 1 - phaseProgress(time, scene.actionStart - 1, scene.actionStart - 0.25);
		const zoom = Math.min(zoomIn, zoomOut);
		return { cameraScale: 1 + 0.9 * zoom, cameraX: -760 * zoom, cameraY: -10 * zoom };
	};

	const replayTo = async (target: number) => {
		if (!timeline) return;
		const bounded = Math.max(0, Math.min(timeline.duration, target));
		for (const scene of timeline.scenes) {
			if (bounded < scene.start) break;
			await invokeOnce(scene, "enter");
			if (bounded < scene.inputStart) break;
			if (bounded < scene.responseStart) {
				await invokeProgressively(
					scene,
					"input",
					phaseProgress(bounded, scene.inputStart, scene.responseStart),
				);
				break;
			}
			await invokeProgressively(scene, "input", 1);
			if (bounded < scene.responseEnd) {
				await invokeProgressively(
					scene,
					"response",
					phaseProgress(bounded, scene.responseStart, scene.responseEnd),
				);
				break;
			}
			await invokeProgressively(scene, "response", 1);
			await invokeOnce(scene, "settled");
			if (bounded < scene.actionStart) break;
			await invokeOnce(scene, "action");
			const closeAt = scene.closeAt ?? Number.POSITIVE_INFINITY;
			const exitAt = scene.exitAt ?? ([3, 4, 5].includes(scene.id) ? scene.end - 1.2 : scene.end);
			if (scene.closeAt !== undefined && bounded < closeAt) break;
			if (scene.closeAt !== undefined) await invokeClose(scene);
			if (bounded < exitAt) break;
			await invokeOnce(scene, "exit");
			if (bounded < scene.end) break;
		}
		await waitForAssets();
		current = bounded;
		if (!playing && !record) audio.currentTime = bounded;
		const scene = sceneAt(timeline, current);
		const inspected = getDemo().inspect();
		const details =
			inspected && typeof inspected === "object" ? (inspected as Record<string, unknown>) : {};
		const point = (key: string) => {
			const value = details[key];
			if (
				!value ||
				typeof value !== "object" ||
				!("x" in value) ||
				!("y" in value) ||
				typeof value.x !== "number" ||
				typeof value.y !== "number"
			)
				throw new Error(`missing real renderer ${key} geometry`);
			return { x: value.x, y: value.y };
		};
		publish({
			time: current,
			duration: timeline.duration,
			sceneId: scene?.id ?? null,
			phase: current >= timeline.duration ? "complete" : scene ? phaseAt(scene, current) : "idle",
			caption: captionAt(timeline, current),
			cursor: cursorAt(
				scene,
				current,
				point("cursorTarget"),
				point("composerTarget"),
				point("sendTarget"),
			),
			...cameraAt(scene, current),
			label: "",
			callouts: [],
		});
	};

	const process = async () => {
		if (busy || disposed) return;
		busy = true;
		try {
			while (desired !== undefined && !disposed) {
				const target = desired;
				desired = undefined;
				if (target < current - 0.0001) {
					getDemo().dispose();
					await loadFrame();
					phaseMarks.clear();
					current = 0;
				}
				await replayTo(target);
			}
			while (waiting.length) waiting.shift()?.resolve();
		} catch (error) {
			playing = false;
			const cause = asError(error);
			publish({ playing: false });
			onError(cause);
			while (waiting.length) waiting.shift()?.reject(cause);
		} finally {
			busy = false;
		}
	};

	const request = (target: number): Promise<void> => {
		desired = target;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		waiting.push({ resolve, reject });
		void process();
		return promise;
	};

	const tick = (wall: number) => {
		if (disposed) return;
		if (playing && timeline) {
			const next = Math.min(timeline.duration, audio.currentTime);
			desired = next;
			void process();
			if (next >= timeline.duration) {
				playing = false;
				publish({ playing: false });
			}
		}
		void wall;
		frameHandle = requestAnimationFrame(tick);
	};
	const ready = (async () => {
		try {
			await document.fonts.ready;
			const response = await fetch("/local-output/timeline.json", { cache: "no-store" });
			if (!response.ok)
				throw new Error(`/local-output/timeline.json returned HTTP ${response.status}`);
			timeline = assertTimeline(await response.json());
			await waitForAudio();
			if (audio.duration && Math.abs(audio.duration - timeline.duration) > 1) {
				throw new Error(
					`audio/timeline duration mismatch (${audio.duration.toFixed(2)}s vs ${timeline.duration.toFixed(2)}s)`,
				);
			}
			await loadFrame();
			publish({
				duration: timeline.duration,
				sceneId: timeline.scenes[0]?.id ?? null,
				phase: "idle",
			});
			await request(0);
		} catch (error) {
			onError(asError(error));
			throw error;
		}
	})();

	frameHandle = requestAnimationFrame(tick);

	const director: PromoDirector = {
		get duration() {
			return timeline?.duration ?? 0;
		},
		ready,
		seek(seconds) {
			playing = false;
			audio.pause();
			publish({ playing: false });
			return request(Number.isFinite(seconds) ? seconds : 0);
		},
		play() {
			if (!timeline || disposed) return;
			if (current >= timeline.duration) {
				void director.replay();
				return;
			}
			playing = true;
			audio.currentTime = current;
			void audio.play().catch((error: unknown) => {
				playing = false;
				publish({ playing: false });
				onError(asError(error));
			});
			publish({ playing: true });
		},
		pause() {
			playing = false;
			audio.pause();
			publish({ playing: false });
		},
		replay() {
			playing = false;
			audio.pause();
			publish({ playing: false });
			return request(0).then(() => {
				playing = true;
				audio.currentTime = 0;
				void audio.play().catch((error: unknown) => {
					playing = false;
					publish({ playing: false });
					onError(asError(error));
				});
				publish({ playing: true });
			});
		},
		dispose() {
			disposed = true;
			playing = false;
			cancelAnimationFrame(frameHandle);
			try {
				getDemo().dispose();
			} catch {
				/* frame may not have loaded */
			}
			iframe.src = "about:blank";
			audio.pause();
		},
		inspect() {
			return { ...state, demo: getDemo().inspect() };
		},
	};
	return director;
}

declare global {
	interface Window {
		promo?: PromoDirector;
	}
}
