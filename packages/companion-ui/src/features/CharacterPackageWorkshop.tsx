import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { FileField } from "@kobalte/core/file-field";
import { TextField } from "@kobalte/core/text-field";
import { createSignal, Show } from "solid-js";
import { useCompanionStore } from "../stores/companion.js";
import type { CharacterDraft } from "../stores/ipc.js";

const starterManifest = `id: my-character
version: 0.1.0
`;

/**
 * Host-backed role-package authoring surface. Binary content is selected as a
 * normal browser File; only this boundary serializes it for the shared RPC.
 */
export function CharacterPackageWorkshop() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [draft, setDraft] = createSignal<CharacterDraft>();
	const [manifest, setManifest] = createSignal(starterManifest);
	const [busy, setBusy] = createSignal(false);
	const [feedback, setFeedback] = createSignal<string>();

	const run = async (action: () => Promise<CharacterDraft>, message: string) => {
		setBusy(true);
		setFeedback();
		try {
			setDraft(await action());
			setFeedback(message);
		} catch (error) {
			setFeedback(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const saveManifest = () => {
		const current = draft();
		if (!current) return;
		void run(
			() =>
				store.characters.draftPatch(current.id, {
					"character.yaml": { encoding: "utf8", content: manifest() },
				}),
			t("packageWorkshop.saved"),
		);
	};

	const uploadImages = async (files: File[]) => {
		const current = draft();
		if (!current || files.length === 0) return;
		await run(
			async () =>
				store.characters.draftUploadAssets(
					current.id,
					current.currentRevision,
					await Promise.all(
						files.map(async (file) => ({
							path: `assets/${file.name}`,
							mime: file.type || "application/octet-stream",
							base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
						})),
					),
				),
			t("packageWorkshop.imagesSaved"),
		);
	};

	return (
		<div class="character-package-workshop">
			<div class="workshop-heading">
				<div>
					<h3>{t("packageWorkshop.title")}</h3>
					<p class="drawer-note">{t("packageWorkshop.note")}</p>
				</div>
				<Show
					when={draft()}
					fallback={
						<Button
							data-control="command"
							disabled={busy()}
							onClick={() =>
								void run(() => store.characters.draftCreate(), t("packageWorkshop.created"))
							}
						>
							{t("packageWorkshop.create")}
						</Button>
					}
				>
					<span class="workshop-revision">
						{t("packageWorkshop.revision", { revision: draft()?.currentRevision ?? 0 })}
					</span>
				</Show>
			</div>
			<Show when={draft()}>
				<TextField>
					<TextField.Label>{t("packageWorkshop.manifest")}</TextField.Label>
					<TextField.TextArea
						rows={12}
						value={manifest()}
						onInput={(event) => setManifest(event.currentTarget.value)}
					/>
				</TextField>
				<div class="workshop-actions">
					<Button data-control="command" disabled={busy()} onClick={saveManifest}>
						{t("packageWorkshop.save")}
					</Button>
					<FileField multiple accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml">
						<FileField.Trigger data-control="command" disabled={busy()}>
							{t("packageWorkshop.addImages")}
						</FileField.Trigger>
						<FileField.HiddenInput
							onChange={(event) => void uploadImages(Array.from(event.currentTarget.files ?? []))}
						/>
					</FileField>
					<Button
						data-control="command"
						disabled={busy()}
						onClick={() => {
							const current = draft();
							if (current)
								void run(
									() => store.characters.draftValidate(current.id, current.currentRevision),
									t("packageWorkshop.validated"),
								);
						}}
					>
						{t("packageWorkshop.validate")}
					</Button>
					<Button
						data-variant="primary"
						disabled={busy() || draft()?.status !== "ready_to_publish"}
						onClick={() => {
							const current = draft();
							if (current)
								void run(
									() => store.characters.draftPublish(current.id, current.currentRevision),
									t("packageWorkshop.published"),
								);
						}}
					>
						{t("packageWorkshop.publish")}
					</Button>
				</div>
				<Show when={feedback()}>{(message) => <p class="drawer-note">{message()}</p>}</Show>
			</Show>
		</div>
	);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 32_768)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
	return btoa(binary);
}
