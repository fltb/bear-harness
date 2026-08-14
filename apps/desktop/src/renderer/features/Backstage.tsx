import { Dialog, Tabs } from "@kobalte/core";
import { Show } from "solid-js";
import type { CharacterDisplay } from "../stores/companion.js";
import { MemoryEntryList, MemorySheet } from "./MemorySheet.js";
import { SettingsSheet } from "./SettingsSheet.js";

/**
 * 幕后 — the backstage right-side sheet.
 *
 * Kobalte 0.13 ships no `Sheet` primitive, so the drawer is built on the
 * `Dialog` family (focus trap, ESC-to-close, aria-modal, labelled title),
 * styled as the prototype's right-side panel. The three backstage pages —
 * 关系档案 / 记忆 / 系统设置 — live in `Tabs`; page state is internal.
 */
export function Backstage(props: {
	open: boolean;
	onClose: () => void;
	character: CharacterDisplay | undefined;
}) {
	return (
		<Dialog.Root
			open={props.open}
			onOpenChange={(isOpen) => {
				if (!isOpen) props.onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay class="backstage-overlay" />
				<Dialog.Content class="backstage-sheet">
					<div class="backstage-head">
						<Dialog.Title class="backstage-title">幕后</Dialog.Title>
						<Dialog.CloseButton class="backstage-close" aria-label="关闭幕后">
							关闭
						</Dialog.CloseButton>
					</div>
					<Tabs.Root defaultValue="relationship" class="backstage-tabs" aria-label="幕后分栏">
						<Tabs.List class="tabs">
							<Tabs.Trigger value="relationship" class="tab">
								关系档案
							</Tabs.Trigger>
							<Tabs.Trigger value="memory" class="tab">
								记忆
							</Tabs.Trigger>
							<Tabs.Trigger value="settings" class="tab">
								系统设置
							</Tabs.Trigger>
						</Tabs.List>
						<Tabs.Content value="relationship" class="tab-panel">
							<RelationshipArchive character={props.character} />
						</Tabs.Content>
						<Tabs.Content value="memory" class="tab-panel">
							<MemorySheet />
						</Tabs.Content>
						<Tabs.Content value="settings" class="tab-panel">
							<SettingsSheet />
						</Tabs.Content>
					</Tabs.Root>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/** 关系档案: locked self-canon plus the relationship-scoped memories. */
function RelationshipArchive(props: { character: CharacterDisplay | undefined }) {
	return (
		<div class="sheet-panel">
			<Show when={props.character}>
				{(character) => (
					<div class="detail-card">
						<strong>{character().name}是谁</strong>
						<span>
							{character().character.subtitle} · {character().character.scene_title}
						</span>
					</div>
				)}
			</Show>
			<p class="drawer-note">这份自我设定随产品版本锁定；普通对话和现实工作都不能改写它。</p>
			<MemoryEntryList scope="relationship" title="已确认的关系记忆" />
		</div>
	);
}
