import { type Accessor, Show } from "solid-js";
import type { PromoState } from "./director";

export interface PromoOverlayProps {
	state: Accessor<PromoState>;
	record: boolean;
	page: number;
}

export function PromoOverlay(props: PromoOverlayProps) {
	const cursorPosition = () => {
		const cursor = props.state().cursor;
		return `translate3d(${cursor.x}px, ${cursor.y}px, 0)`;
	};

	return (
		<div class="promo-overlay" aria-hidden="true">
			<div class="promo-scripted-marker">预设情景 · SCRIPTED</div>
			<div
				class="promo-cursor"
				classList={{ "is-clicking": props.state().cursor.clicking }}
				style={{ transform: cursorPosition() }}
			/>
			<Show when={props.page === 4}>
				<p class="promo-import-note">RJ、沃利贝尔：外部角色包导入示例，不随应用提供</p>
			</Show>
			<Show when={props.page === 9}>
				<section class="promo-closing-info">
					<h2>白熊客栈</h2>
					<p>安装和使用说明</p>
					<a href="https://github.com/fltb/bear-harness">github.com/fltb/bear-harness</a>
					<p>使用前需要先配置模型。</p>
					<small>
						极昼随应用提供。
						<br />
						RJ、沃利贝尔为外部导入示例。
					</small>
					<small>
						本片为预设情景演示，
						<br />
						不代表实时模型输出。
					</small>
				</section>
			</Show>
			<Show when={props.state().caption}>
				<div class="promo-caption-safe">{props.state().caption}</div>
			</Show>
		</div>
	);
}
