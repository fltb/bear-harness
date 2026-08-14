import { createSignal, For, Show } from "solid-js";
import type { RelationKind } from "./stores/companion.js";
import { useCompanionStore } from "./stores/companion.js";

/**
 * FirstMeeting: the "门后的第一夜" intro overlay from Prototype 06, driven
 * by the onboarding FSM state from the store.
 *
 * Steps and their wire actions:
 * - door_closed / introduced → first-night card; "把门打开" calls
 *   `advanceOnboarding` (re-fetch until the host's onboarding.advance
 *   channel lands).
 * - naming → name form; submit calls `setOnboardingName` (auto-advances to
 *   relation in the FSM).
 * - relation → choice cards; each calls `setOnboardingRelation`.
 * - memory_decision → two choices calling `setOnboardingMemoryDecision`
 *   (auto-advances to voice_ready).
 * - voice_ready → passive wait card; the host completes it when the voice
 *   stack is pinned, and the `onboarding.state_changed` event flips the
 *   store state to "complete", hiding this overlay.
 *
 * Failures surface inline through `store.error` and the action stays
 * available for retry.
 */

const RELATIONS: ReadonlyArray<{ kind: RelationKind; title: string; note: string }> = [
	{ kind: "shelter", title: "开门让他住下的人", note: "先从共享这间书房开始" },
	{ kind: "partner", title: "一起守望的人", note: "平等地共同面对接下来的事" },
	{ kind: "ward", title: "需要他照顾的人", note: "他先守着你，再守书房" },
	{ kind: "biding", title: "先看看再说", note: "不急着定义，相处会自己说话" },
];

const STEP_LABELS: Record<string, string> = {
	door_closed: "门后的第一夜 · 01 / 05",
	introduced: "门后的第一夜 · 01 / 05",
	naming: "门后的第一夜 · 02 / 05",
	relation: "门后的第一夜 · 03 / 05",
	memory_decision: "门后的第一夜 · 04 / 05",
	voice_ready: "门后的第一夜 · 05 / 05",
};

export function FirstMeeting() {
	const store = useCompanionStore();
	const [name, setName] = createSignal("");

	const state = () => store.onboarding.state;

	const submitName = () => {
		const value = name().trim();
		if (value.length === 0) return;
		void store.setOnboardingName(value);
	};

	return (
		<Show when={state() !== "complete" && !store.loading}>
			<section class="intro" role="dialog" aria-modal="true" aria-label="首次入场">
				<article class="intro-card">
					<div class="intro-step">{STEP_LABELS[state()] ?? "门后的第一夜"}</div>

					<Show when={state() === "door_closed" || state() === "introduced"}>
						<h2>门外有风雪，也有一只不认识你的熊。</h2>
						<p>
							他已经有自己的过去，却不知道你是谁，也看不见任何你尚未允许的电脑内容。
						</p>
						<p class="intro-quote">
							<em>门后的冷气只持续了一瞬。白熊环视房间，把一本旧值守簿放到桌上。</em>
							<br />
							“这里不是极光站。门是你开的？”
						</p>
						<Show when={store.error !== null}>
							<p class="intro-error" role="alert">
								没有完成：{store.error}
							</p>
						</Show>
						<div class="intro-actions">
							<button
								type="button"
								class="primary"
								onClick={() => void store.advanceOnboarding()}
							>
								{state() === "introduced" ? "走进书房" : "把门打开"}
							</button>
						</div>
					</Show>

					<Show when={state() === "naming"}>
						<h2>先自然地认识彼此。</h2>
						<p>不用填写 Persona 表。这个称呼只在你确认后进入关系设置。</p>
						<div class="intro-form">
							<label for="intro-name">希望我怎么称呼你？</label>
							<input
								id="intro-name"
								type="text"
								placeholder="例如：林"
								value={name()}
								onInput={(event) => setName(event.currentTarget.value)}
							/>
						</div>
						<Show when={store.error !== null}>
							<p class="intro-error" role="alert">
								没有完成：{store.error}
							</p>
						</Show>
						<div class="intro-actions">
							<button
								type="button"
								class="primary"
								disabled={name().trim().length === 0}
								onClick={submitName}
							>
								确认称呼
							</button>
						</div>
					</Show>

					<Show when={state() === "relation"}>
						<h2>今晚从什么关系开始？</h2>
						<p>这只是相处起点，不是永久标签，也不会改变现实权限。</p>
						<div class="intro-choices">
							<For each={RELATIONS}>
								{(relation) => (
									<button
										type="button"
										class="intro-choice"
										onClick={() => void store.setOnboardingRelation(relation.kind)}
									>
										<strong>{relation.title}</strong>
										<span>{relation.note}</span>
									</button>
								)}
							</For>
						</div>
						<Show when={store.error !== null}>
							<p class="intro-error" role="alert">
								没有完成：{store.error}
							</p>
						</Show>
					</Show>

					<Show when={state() === "memory_decision"}>
						<h2>要记得你，还是只陪这一晚？</h2>
						<p>
							关系记忆只保存你明确确认的称呼、偏好与共同经历；每次新增仍会先问你，也可以随时查看、修改或忘掉。
						</p>
						<div class="intro-choices">
							<button
								type="button"
								class="intro-choice"
								onClick={() => void store.setOnboardingMemoryDecision(true)}
							>
								<strong>开启，但每次问我</strong>
								<span>允许记住你确认的部分，新增前先征求同意</span>
							</button>
							<button
								type="button"
								class="intro-choice"
								onClick={() => void store.setOnboardingMemoryDecision(false)}
							>
								<strong>暂时不要，也继续</strong>
								<span>称呼只用于今晚；聊天与现实工作都不受影响</span>
							</button>
						</div>
						<Show when={store.error !== null}>
							<p class="intro-error" role="alert">
								没有完成：{store.error}
							</p>
						</Show>
					</Show>

					<Show when={state() === "voice_ready"}>
						<h2>声音正在就绪。</h2>
						<p>
							正在准备声音。这一步由系统自动完成，准备好之后，这扇门就正式打开了。
						</p>
						<p class="memory-note" aria-live="polite">
							正在等待系统确认声音设置…
						</p>
					</Show>
				</article>
			</section>
		</Show>
	);
}
