import type { ProductCharacter } from "../../product.config";
import type { ActiveSection } from "./App";

/**
 * Sidebar: identity, disabled search/new-conversation tools, the two
 * role-content navigation items (the only interactive controls besides the
 * scene switch) and the disabled system section.
 */
export function Sidebar(props: {
	character: ProductCharacter;
	activeSection: ActiveSection;
	onSelect: (section: ActiveSection) => void;
}) {
	// Nav labels derive from the scene titles (the part after " · " when present)
	// so forks get natural labels without duplicating copy.
	const homeLabel = () =>
		props.character.sceneTitle.split(" · ").pop() ?? props.character.sceneTitle;
	const oldStationLabel = () =>
		props.character.oldStationTitle.split(" · ").pop() ?? props.character.oldStationTitle;

	return (
		<aside class="sidebar">
			<div class="identity">
				<div class="avatar" aria-hidden="true">
					<div class="face" />
				</div>
				<div>
					<strong>{props.character.name}</strong>
					<span>{props.character.subtitle}</span>
				</div>
			</div>
			<div class="sidebar-tools">
				<button type="button" class="search-trigger" disabled>
					<span aria-hidden="true">⌕</span>
					<span>搜索</span>
					<kbd>⌘K</kbd>
				</button>
				<button type="button" class="new-conversation" disabled aria-label="新建对话">
					＋
				</button>
			</div>
			<div class="nav-scroll">
				<nav class="nav-list" aria-label="对话">
					<button
						type="button"
						class="nav-item"
						aria-current={props.activeSection === "home" ? "page" : undefined}
						onClick={() => props.onSelect("home")}
					>
						<strong>{homeLabel()}</strong>
						<span>今晚 · 继续相处</span>
					</button>
					<button
						type="button"
						class="nav-item"
						aria-current={props.activeSection === "old-station" ? "page" : undefined}
						onClick={() => props.onSelect("old-station")}
					>
						<strong>{oldStationLabel()}</strong>
						<span>关于{props.character.name}的过去</span>
					</button>
					<button type="button" class="nav-item" disabled>
						<strong>把会议变成报告</strong>
						<span>等你开始</span>
					</button>
					<button type="button" class="nav-item" disabled>
						<strong>把夏天归进月份</strong>
						<span>等你开始</span>
					</button>
				</nav>
				<div class="system-section">
					<div class="section-label">应用</div>
					<button type="button" class="system-nav" disabled>
						<span class="gear" aria-hidden="true">
							◇
						</span>
						关系档案
					</button>
					<button type="button" class="system-nav" disabled>
						<span class="gear" aria-hidden="true">
							⚙
						</span>
						系统设置
					</button>
				</div>
			</div>
		</aside>
	);
}
