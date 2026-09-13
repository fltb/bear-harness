import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import slides from "./demo/slides.json";
import { createPromoDirector, type PromoDirector, type PromoState } from "./director";
import { PromoOverlay } from "./overlay";
import "./promo.css";

interface PromoSlide {
	id: number;
	title: string;
	subtitle: string;
	narration: string;
}

const PROMO_SLIDES = slides as PromoSlide[];
const PAGE_BY_SCENE: Record<number, number> = {
	"0": 1,
	"1": 2,
	"2": 2,
	"3": 3,
	"4": 4,
	"5": 4,
	"6": 4,
	"7": 4,
	"8": 5,
	"9": 5,
	"10": 6,
	"11": 7,
	"12": 7,
	"13": 8,
	"14": 9,
};

const initialState: PromoState = {
	time: 0,
	duration: 0,
	sceneId: null,
	phase: "idle",
	caption: "",
	playing: false,
	debug: false,
	cursor: { x: 800, y: 400, clicking: false },
	cameraScale: 1,
	cameraX: 0,
	cameraY: 0,
	label: "",
	callouts: [],
};

function formatTime(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(total / 60)
		.toString()
		.padStart(2, "0");
	const remainder = (total % 60).toString().padStart(2, "0");
	return `${minutes}:${remainder}`;
}

function pageForScene(sceneId: number | null): number {
	return sceneId === null ? 1 : (PAGE_BY_SCENE[sceneId] ?? 1);
}

function PromoStage() {
	const [state, setState] = createSignal<PromoState>(initialState);
	const [error, setError] = createSignal("");
	const [stageScale, setStageScale] = createSignal(
		Math.min(window.innerWidth / 1920, window.innerHeight / 1080),
	);
	const [pageStarts, setPageStarts] = createSignal<number[]>(PROMO_SLIDES.map(() => 0));
	const params = new URLSearchParams(window.location.search);
	const record = params.get("record") === "1";
	const capture = params.get("capture") === "1";
	const debug = params.get("debug") === "1";
	let director: PromoDirector | undefined;
	let iframe!: HTMLIFrameElement;
	let audio!: HTMLAudioElement;

	onMount(() => {
		const resize = () =>
			setStageScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
		window.addEventListener("resize", resize);
		onCleanup(() => window.removeEventListener("resize", resize));

		const timelineReady = fetch("/local-output/timeline.json", { cache: "no-store" })
			.then(async (response) => {
				if (!response.ok) throw new Error(`timeline.json returned HTTP ${response.status}`);
				return (await response.json()) as { scenes?: Array<{ id?: unknown; start?: unknown }> };
			})
			.then((timeline) => {
				const starts = PROMO_SLIDES.map(() => Number.POSITIVE_INFINITY);
				for (const scene of timeline.scenes ?? []) {
					if (typeof scene.id !== "number" || typeof scene.start !== "number") continue;
					const page = PAGE_BY_SCENE[scene.id];
					if (page !== undefined)
						starts[page - 1] = Math.min(starts[page - 1] ?? Infinity, scene.start);
				}
				starts[0] = Number.isFinite(starts[0] ?? Infinity) ? (starts[0] as number) : 0;
				for (let index = 1; index < starts.length; index += 1) {
					if (!Number.isFinite(starts[index] ?? Infinity)) starts[index] = starts[index - 1] ?? 0;
				}
				setPageStarts(starts.map((start) => (Number.isFinite(start) ? start : 0)));
			})
			.catch(() => undefined);

		director = createPromoDirector({
			iframe,
			audio,
			record,
			debug,
			onState: setState,
			onError: (cause) => setError(cause.message),
		});
		window.promo = director;
		void timelineReady;
		void director.ready.catch(() => undefined);
	});

	onCleanup(() => {
		director?.dispose();
		if (window.promo === director) delete window.promo;
	});

	const seekFromInput = (event: Event) => {
		const input = event.currentTarget as HTMLInputElement;
		const operation = director?.seek(Number(input.value));
		if (operation) void operation.catch(() => undefined);
	};
	const seekPage = (page: number) => {
		const operation = director?.seek(pageStarts()[page - 1] ?? 0);
		if (operation) void operation.catch(() => undefined);
	};
	const currentPage = () => pageForScene(state().sceneId);
	const currentSlide = () => PROMO_SLIDES[currentPage() - 1] ?? PROMO_SLIDES[0];

	return (
		<main classList={{ "promo-shell": true, "is-record": record || capture }}>
			<div
				class="promo-stage"
				data-promo-stage="true"
				data-page={currentPage()}
				style={{ transform: `translate(-50%, -50%) scale(${stageScale()})` }}
			>
				<header class="promo-header">
					<div class="promo-brand">
						<span class="promo-brand-mark" aria-hidden="true">
							◒
						</span>
						<span>白熊客栈</span>
					</div>
					<div class="promo-header-copy">
						<h1>{currentSlide()?.title}</h1>
						<p>{currentSlide()?.subtitle}</p>
					</div>
					<div class="promo-page-indicator">
						<span>页面</span>
						<strong>{String(currentPage()).padStart(2, "0")}</strong>
						<small>/ 09</small>
					</div>
					<nav class="promo-page-nav" aria-label="跳转页面">
						{PROMO_SLIDES.map((slide) => (
							<button
								type="button"
								classList={{ "is-current": currentPage() === slide.id }}
								aria-current={currentPage() === slide.id ? "page" : undefined}
								aria-label={`跳转到第 ${slide.id} 页：${slide.title}`}
								onClick={() => seekPage(slide.id)}
							>
								{String(slide.id).padStart(2, "0")}
							</button>
						))}
					</nav>
				</header>

				<section class="promo-window" aria-label="白熊客栈应用窗口">
					<div class="promo-window-titlebar">
						<div class="promo-window-controls" aria-hidden="true">
							<span />
							<span />
							<span />
						</div>
						<span class="promo-window-title">白熊客栈</span>
						<span class="promo-window-status">预设情景演示</span>
					</div>
					<div class="promo-renderer-viewport">
						<div
							class="promo-renderer-frame"
							style={{
								transform: `translate(calc(-50% + ${state().cameraX}px), ${state().cameraY}px) scale(${state().cameraScale})`,
							}}
						>
							<iframe ref={iframe} title="白熊客栈真实应用演示" />
						</div>
					</div>
				</section>

				<PromoOverlay state={state} record={record} page={currentPage()} />
				<Show when={debug}>
					<output class="promo-debug">
						t={state().time.toFixed(2)} / {state().duration.toFixed(2)} · scene=
						{state().sceneId ?? "-"} · {state().phase}
					</output>
				</Show>

				<nav class="promo-controls" aria-label="宣传片播放控制">
					<button
						type="button"
						class="promo-play-button"
						onClick={() => (state().playing ? director?.pause() : director?.play())}
					>
						{state().playing ? "暂停" : "播放"}
					</button>
					<input
						aria-label="视频进度"
						type="range"
						min="0"
						max={state().duration || 1}
						step="0.01"
						value={state().time}
						onInput={seekFromInput}
					/>
					<button
						type="button"
						onClick={() => {
							const operation = director?.replay();
							if (operation) void operation.catch(() => undefined);
						}}
					>
						重播
					</button>
					<span class="promo-time">
						{formatTime(state().time)} / {formatTime(state().duration)}
					</span>
				</nav>
				<audio ref={audio} preload="auto" src={record ? undefined : "/local-output/narration.wav"}>
					<track
						kind="captions"
						src="/local-output/captions.vtt"
						srclang="zh-CN"
						label="中文旁白"
						default
					/>
				</audio>
			</div>
			<Show when={error()}>
				<div class="promo-error">制作停止：{error()}</div>
			</Show>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
render(() => <PromoStage />, root);
