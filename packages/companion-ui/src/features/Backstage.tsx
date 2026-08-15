import { productUi } from "@bear-harness/product-config";
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
						<Dialog.Title class="backstage-title">{productUi.backstage.title}</Dialog.Title>
						<Dialog.CloseButton class="backstage-close" aria-label={productUi.backstage.close}>
							{productUi.backstage.close}
						</Dialog.CloseButton>
					</div>
					<Tabs.Root
						defaultValue="relationship"
						class="backstage-tabs"
						aria-label={productUi.backstage.tabsLabel}
					>
						<Tabs.List class="tabs">
							<Tabs.Trigger value="relationship" class="tab">
								{productUi.backstage.relationshipArchive}
							</Tabs.Trigger>
							<Tabs.Trigger value="memory" class="tab">
								{productUi.backstage.memory}
							</Tabs.Trigger>
							<Tabs.Trigger value="settings" class="tab">
								{productUi.backstage.systemSettings}
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
						<strong>
							{character().name}
							{productUi.backstage.identitySuffix}
						</strong>
						<span>
							{character().character.subtitle} · {character().character.scene_title}
						</span>
					</div>
				)}
			</Show>
			<p class="drawer-note">{productUi.backstage.identityNote}</p>
			<MemoryEntryList scope="relationship" title={productUi.backstage.relationshipMemories} />
		</div>
	);
}
