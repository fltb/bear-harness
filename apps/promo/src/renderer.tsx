import { createCompanionClient } from "@bear-harness/companion-client";
import { CompanionApp, useCompanionStore } from "@bear-harness/companion-ui";
import { productConfig } from "@bear-harness/product-config";
import { onCleanup } from "solid-js";
import { render } from "solid-js/web";
import "@bear-harness/companion-ui/styles.css";
import { DEMO_CHARACTERS, SCENARIO } from "./demo/scenario";
import { createDemoTransport, DemoTransportError } from "./demo/transport";

interface DemoApi {
	ready: Promise<void>;
	advance(sceneId: number, phase: string, progress?: number): Promise<void>;
	inspect(): unknown;
	dispose(): void;
}

declare global {
	interface Window {
		demo: DemoApi;
	}
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
const transport = createDemoTransport();
const client = createCompanionClient(transport);
let disposed = false;
let currentScene = 0;
const submittedInputs = new Set<number>();
const typedProgress = new Map<number, number>();
let lastControl = { x: 800, y: 750 };
function controlCenter(element: Element | null) {
	if (!element) return lastControl;
	const rect = element.getBoundingClientRect();
	return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function showError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const target = document.getElementById("demo-error");
	if (target) {
		target.textContent = message;
		target.hidden = false;
	}
	window.dispatchEvent(new CustomEvent("demo:fault", { detail: { message } }));
}

// Observe the real window-local store; the scripted Host never owns UI selection.
let inspectSelection: () => { characterId: string | null; activeConversationId: string | null } =
	() => ({ characterId: null, activeConversationId: null });
function ObserveSelection() {
	const store = useCompanionStore();
	inspectSelection = () => ({
		characterId: store.character?.id ?? null,
		activeConversationId: store.activeConversationId,
	});
	onCleanup(() => {
		inspectSelection = () => ({ characterId: null, activeConversationId: null });
	});
	return null;
}
const appDispose = render(
	() => (
		<CompanionApp product={productConfig} client={client} platform="web">
			<ObserveSelection />
		</CompanionApp>
	),
	root,
);
const ready = (async () => {
	await document.fonts.ready;
	await new Promise<void>((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
	);
	await waitFor(() => Boolean(root.querySelector('[role="application"]')), "CompanionApp mount");
	await selectConversation("jizhou-night-reading");
})();

function visibleButtons(): HTMLButtonElement[] {
	return [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
		(button) => !button.hidden && button.getClientRects().length > 0 && !button.disabled,
	);
}
function buttonLabel(button: HTMLButtonElement): string {
	return `${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""} ${button.title}`.toLocaleLowerCase();
}
function clickButton(text: string): HTMLButtonElement {
	const wanted = text.toLocaleLowerCase();
	const button = visibleButtons().find((candidate) => buttonLabel(candidate).includes(wanted));
	if (!button) throw new Error(`required real UI button not found: ${text}`);
	lastControl = controlCenter(button);
	button.click();
	return button;
}
async function waitFor(
	predicate: () => boolean,
	description: string,
	timeoutMs = 4000,
): Promise<void> {
	const started = performance.now();
	while (!predicate()) {
		if (performance.now() - started >= timeoutMs)
			throw new Error(`timed out waiting for real UI: ${description}`);
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
}
function activeConversationButton(id: string): HTMLButtonElement | undefined {
	return (
		document.querySelector<HTMLButtonElement>(`button[data-conversation-id="${CSS.escape(id)}"]`) ??
		undefined
	);
}
async function closeBackstage(): Promise<void> {
	const close = visibleButtons().find((button) =>
		button.getAttribute("aria-label")?.includes("关闭"),
	);
	if (!close) throw new Error("required real backstage close control not found");
	close.click();
	await waitFor(() => !document.querySelector(".backstage-sheet"), "backstage close");
}
async function switchCharacter(name: string, id: string): Promise<void> {
	if (inspectSelection().characterId === id) return;
	if (!document.querySelector(".backstage-sheet")) clickButton("角色设置");
	await waitFor(
		() =>
			[...document.querySelectorAll<HTMLElement>(".role-row")].some((row) =>
				row.textContent?.includes(name),
			),
		`${name} role row`,
	);
	const row = [...document.querySelectorAll<HTMLElement>(".role-row")].find((candidate) =>
		candidate.textContent?.includes(name),
	);
	if (!row) throw new Error(`required real role row not found: ${name}`);
	const switcher = [...row.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
		buttonLabel(button).includes("切换"),
	);
	if (!switcher) throw new Error(`required real role switch control not found: ${name}`);
	switcher.click();
	await waitFor(() => inspectSelection().characterId === id, `${name} activation`);
	await closeBackstage();
}
async function selectConversation(id: string): Promise<void> {
	await waitFor(
		() => activeConversationButton(id) !== undefined,
		`conversation ${id} in real sidebar`,
	);
	const button = activeConversationButton(id);
	if (!button) throw new Error(`required real conversation control not found: ${id}`);
	button.click();
	await waitFor(
		() => inspectSelection().activeConversationId === id,
		`conversation ${id} selection`,
	);
}
async function createConversation(): Promise<void> {
	clickButton("新建对话");
	await waitFor(
		() => inspectSelection().activeConversationId === "jizhou-night-reading-2",
		"real new conversation creation",
	);
}
async function closeResultWorkspace(): Promise<void> {
	const close = visibleButtons().find((button) => buttonLabel(button).includes("关闭"));
	if (!close) throw new Error("required real result workspace close control not found");
	close.click();
	await waitFor(() => !document.querySelector("[role='dialog']"), "result workspace close");
}

async function enterScene(sceneId: number): Promise<void> {
	if (sceneId === 0) return;
	transport.prepare(sceneId);
	if (sceneId === 4) {
		await switchCharacter("RJ", "rj");
		await selectConversation("rj-moving-books");
	} else if (sceneId === 6) {
		await switchCharacter("沃利贝尔", "volibear");
		await selectConversation("volibear-wind");
	} else if (sceneId === 8 || sceneId === 9) {
		await switchCharacter("极昼", "jizhou");
		await selectConversation("jizhou-night-reading");
	} else if (sceneId === 10) {
		await switchCharacter("极昼", "jizhou");
		await createConversation();
	} else if (sceneId === 12) {
		await switchCharacter("极昼", "jizhou");
		await selectConversation("jizhou-night-reading");
	} else if (sceneId === 13) {
		await switchCharacter("极昼", "jizhou");
		await selectConversation("jizhou-night-reading-2");
	} else if (sceneId === 14) {
		await closeResultWorkspace();
		await switchCharacter("极昼", "jizhou");
		await selectConversation("jizhou-night-reading");
	}
}

async function revealResult(): Promise<void> {
	await waitFor(
		() => visibleButtons().some((button) => buttonLabel(button).includes("查看成果")),
		"completed work result entry",
	);
	clickButton("查看成果");
	await waitFor(
		() => visibleButtons().some((button) => buttonLabel(button).includes("保存副本")),
		"real artifact workspace",
	);
}

function setComposer(text: string): { area: HTMLTextAreaElement; form: HTMLFormElement } {
	const area = document.querySelector<HTMLTextAreaElement>(
		'.composer textarea[aria-label], textarea[aria-label*="消息"], textarea',
	);
	if (!area) throw new Error("required real UI composer textarea not found");
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
	if (!setter) throw new Error("textarea value setter unavailable");
	setter.call(area, text);
	area.dispatchEvent(
		new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
	);
	const form = area.closest("form");
	if (!(form instanceof HTMLFormElement)) throw new Error("required real composer form not found");
	return { area, form };
}
async function inputScene(sceneId: number, progress: number): Promise<void> {
	const scene = SCENARIO.find((item) => item.id === sceneId);
	if (!scene?.user) return;
	const bounded = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
	const previous = typedProgress.get(sceneId) ?? 0;
	if (bounded < previous) throw new Error(`input progress moved backwards for scene ${sceneId}`);
	typedProgress.set(sceneId, bounded);
	const text = Array.from(scene.user)
		.slice(0, Math.floor(Array.from(scene.user).length * bounded))
		.join("");
	setComposer(text);
	if (bounded >= 1 && !submittedInputs.has(sceneId)) {
		submittedInputs.add(sceneId);
		const form = setComposer(scene.user).form;
		form.requestSubmit();
		await waitFor(
			() => (transport.inspect().pendingScene as number | null) === sceneId,
			`scene ${sceneId} message send`,
		);
	}
}
async function actionScene(sceneId: number): Promise<void> {
	if (sceneId === 9) {
		if (!document.querySelector(".backstage-sheet")) clickButton("角色设置");
		await waitFor(
			() => visibleButtons().some((button) => buttonLabel(button).includes("关系记忆")),
			"real relationship memory control",
		);
		clickButton("关系记忆");
		await waitFor(
			() => Boolean(document.querySelector("[data-memory-character='jizhou']")),
			"real memory panel",
		);
		clickButton("显式记忆");
		await waitFor(
			() =>
				document
					.querySelector("[data-memory-character='jizhou']")
					?.textContent?.includes("靠窗坐") === true,
			"saved explicit memory document",
		);
	} else if (sceneId === 13) {
		const downloaded = new Promise<void>((resolve) =>
			window.addEventListener("demo:download", () => resolve(), { once: true }),
		);
		clickButton("保存副本");
		await downloaded;
	} else if (sceneId === 14) {
		// The result workspace is closed on scene entry, before the closing card.
		return;
	}
}
async function exitScene(sceneId: number): Promise<void> {
	if (sceneId === 9) await closeBackstage();
}

const demo: DemoApi = {
	ready,
	async advance(sceneId, phase, progress = 1) {
		if (disposed) throw new Error("demo renderer has been disposed");
		await ready;
		try {
			const scene = SCENARIO.find((item) => item.id === sceneId);
			if (!scene) throw new Error(`unknown scene ${sceneId}`);
			if (
				!["enter", "input", "response", "settled", "action", "close", "exit", "reveal"].includes(
					phase,
				)
			)
				throw new Error(`unknown demo phase ${phase}`);
			if (phase === "enter") {
				currentScene = sceneId;
				await enterScene(sceneId);
			} else if (phase === "reveal") {
				if (sceneId !== 13) throw new Error("Result reveal belongs to scene 13");
				await revealResult();
			} else if (phase === "input") await inputScene(sceneId, progress);
			else if (phase === "response" || phase === "settled" || phase === "action") {
				if (sceneId !== 0 && scene.user) transport.advance(sceneId, phase, progress);
				if (phase === "action") await actionScene(sceneId);
			} else if (phase === "close") return;
			else if (phase === "exit") await exitScene(sceneId);
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			if (transport.inspect().fault)
				throw new Error(transport.inspect().fault ?? "demo transport failure");
		} catch (error) {
			showError(error);
			throw error instanceof DemoTransportError
				? error
				: new Error(error instanceof Error ? error.message : String(error));
		}
	},
	inspect() {
		const labels: Record<number, string> = { 9: "角色设置", 13: "保存副本" };
		const label = labels[currentScene];
		const target = label
			? visibleButtons().find((button) => buttonLabel(button).includes(label))
			: undefined;
		const area = document.querySelector(".composer textarea");
		return {
			...transport.inspect(),
			...inspectSelection(),
			sceneId: currentScene,
			characterIds: Object.keys(DEMO_CHARACTERS),
			cursorTarget: target ? controlCenter(target) : lastControl,
			composerTarget: controlCenter(area),
			sendTarget: controlCenter(
				area?.closest("form")?.querySelector('button[type="submit"]') ?? null,
			),
			artifactSelected: Boolean(document.querySelector("[data-artifact-preview]")),
			mediaOpen: Boolean(document.querySelector(".media-viewer")),
			memoryOpen: Boolean(document.querySelector("[data-memory-character]")),
		};
	},
	dispose() {
		if (disposed) return;
		disposed = true;
		transport.dispose();
		appDispose();
	},
};
window.demo = demo;
window.addEventListener("demo:download", ((
	event: CustomEvent<{ filename: string; content: string }>,
) => {
	const blob = new Blob([event.detail.content], { type: "text/markdown;charset=utf-8" });
	const link = document.createElement("a");
	link.href = URL.createObjectURL(blob);
	link.download = event.detail.filename;
	link.click();
	setTimeout(() => URL.revokeObjectURL(link.href), 0);
}) as EventListener);
ready.catch(showError);
