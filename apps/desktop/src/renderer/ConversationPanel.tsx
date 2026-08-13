import type { ProductCharacter } from "../../product.config";
import type { ActiveSection } from "./App";

/**
 * The single static conversation message. Copy comes from the product config
 * character; the meta/action lines are derived so forks read naturally.
 */
export function ConversationPanel(props: {
	character: ProductCharacter;
	section: ActiveSection;
	greeting: string;
}) {
	const meta = () =>
		props.section === "home"
			? `${props.character.name} · 雪停以后`
			: `${props.character.name} · 自我记忆`;
	const action = () =>
		props.section === "home"
			? `窗外的风终于安静。${props.character.name}把灯转向你，又把自己的值守簿压在爪下。`
			: `值守簿翻到一页被反复修补的故障记录。${props.character.name}用爪尖压住了其中一句“修复完成”。`;

	return (
		<section class="thread" aria-live="polite" aria-label="对话">
			<div class="msg bear-msg">
				<div class="msg-meta">{meta()}</div>
				<em>{action()}</em>
				<p>{props.greeting}</p>
			</div>
		</section>
	);
}
