import { i18n, useTranslation } from "@bear-harness/i18n";
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { parseDocument } from "yaml";
import { renderMarkdown } from "../../MessageContent.js";
import type { CharacterApi } from "../../stores/supplementary-api.js";
import { Button, Dialog, TextField } from "../../ui/primitives.js";
import { EditorSelect } from "./SchemaFields.js";

const mediaType = (path: string) =>
	/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(path)
		? "image"
		: /\.(mp4|webm|mov)$/i.test(path)
			? "video"
			: /\.(mp3|wav|ogg|m4a|flac)$/i.test(path)
				? "audio"
				: "text";
const mime = (path: string) =>
	path.endsWith(".svg")
		? "image/svg+xml"
		: path.endsWith(".vtt")
			? "text/vtt"
			: path.endsWith(".mp4")
				? "video/mp4"
				: path.endsWith(".webm")
					? "video/webm"
					: path.endsWith(".mp3")
						? "audio/mpeg"
						: undefined;
export function DraftAsset(props: {
	api: CharacterApi;
	files?: Record<string, { sha256: string }>;
	id: string;
	path: string;
	captions?: string;
	label?: string;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const [expanded, setExpanded] = createSignal(false);
	const urls = new Set<string>();
	let disposed = false;
	onCleanup(() => {
		disposed = true;
		for (const url of urls) URL.revokeObjectURL(url);
	});
	const [source] = createResource(
		() => `${props.id}/${props.path}`,
		async () => {
			const bytes = await props.api.draftFile(
				props.id,
				props.path,
				props.files?.[props.path]?.sha256,
			);
			const url = URL.createObjectURL(
				new Blob([new Uint8Array(bytes)], { type: mime(props.path) }),
			);
			if (disposed) URL.revokeObjectURL(url);
			else urls.add(url);
			return { url, text: mediaType(props.path) === "text" ? new TextDecoder().decode(bytes) : "" };
		},
	);
	const [caption] = createResource(
		() => props.captions,
		async (path) => {
			const bytes = await props.api.draftFile(props.id, path, props.files?.[path]?.sha256);
			const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "text/vtt" }));
			if (disposed) URL.revokeObjectURL(url);
			else urls.add(url);
			return url;
		},
	);
	const result = () => (source.error ? undefined : source());
	return (
		<section class="studio-asset-preview" data-expanded={expanded()}>
			<Show when={source.loading}>
				<p role="status">{t("studio.loading")}</p>
			</Show>
			<Show when={source.error || caption.error}>
				<p role="alert">{String(source.error || caption.error)}</p>
			</Show>
			<Show when={result()}>
				{(value) => (
					<Show
						when={mediaType(props.path) === "image"}
						fallback={
							<Show
								when={mediaType(props.path) === "video"}
								fallback={
									<Show
										when={mediaType(props.path) === "audio"}
										fallback={
											<article class="message-markdown" innerHTML={renderMarkdown(value().text)} />
										}
									>
										<audio controls aria-label={props.label ?? props.path} src={value().url}>
											<track
												kind="captions"
												src={caption.error ? undefined : caption()}
												srclang="zh"
											/>
										</audio>
									</Show>
								}
							>
								<video controls aria-label={props.label ?? props.path} src={value().url}>
									<track
										kind="captions"
										src={caption.error ? undefined : caption()}
										srclang="zh"
										default
									/>
								</video>
							</Show>
						}
					>
						<Button onClick={() => setExpanded(!expanded())}>
							{t(expanded() ? "studio.fitPreview" : "studio.originalPreview")}
						</Button>
						<img src={value().url} alt={props.label ?? props.path} />
					</Show>
				)}
			</Show>
		</section>
	);
}
export function DraftPreview(props: {
	api: CharacterApi;
	files?: Record<string, { sha256: string }>;
	id: string;
	source: string;
	file?: string;
	captions?: string;
	onClose(): void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const [scene, setScene] = createSignal("");
	const [expression, setExpression] = createSignal("");
	const [media, setMedia] = createSignal("");
	const [step, setStep] = createSignal(0);
	const manifest = createMemo(() => {
		try {
			const doc = parseDocument(props.source);
			return doc.errors.length ? {} : (doc.toJS() as Record<string, any>);
		} catch {
			return {};
		}
	});
	const scenes = () => manifest().scenes ?? [];
	const expressions = () => manifest().visual?.expressions ?? [];
	const medias = () => manifest().media ?? [];
	const steps = () => manifest().character?.first_meeting?.steps ?? [];
	const background = () =>
		scenes().find(
			(item: any) =>
				item.id === (scene() || scenes().find((item: any) => item.default)?.id || scenes()[0]?.id),
		);
	const standing = () =>
		expressions().find(
			(item: any) => item.id === (expression() || manifest().visual?.default_expression),
		);
	const selectedMedia = () => medias().find((item: any) => item.id === media());
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay class="confirmation-overlay" />
				<Dialog.Content class="studio-preview-dialog">
					<header class="studio-tools">
						<Dialog.Title>{t("studio.preview")}</Dialog.Title>
						<Dialog.CloseButton as={Button} aria-label={t("backstage.close")}>
							{t("backstage.close")}
						</Dialog.CloseButton>
					</header>
					<p>{t("studio.previewHint")}</p>
					<Show
						when={props.file}
						fallback={
							<>
								<h2>{manifest().name}</h2>
								<p>{manifest().character?.subtitle}</p>
								<p>{manifest().character?.greeting}</p>
								<div class="studio-tools">
									<EditorSelect
										label="scenes"
										options={scenes().map((item: any) => String(item.id))}
										value={background()?.id ?? ""}
										onChange={setScene}
									/>
									<EditorSelect
										label="visual.expressions"
										options={expressions().map((item: any) => String(item.id))}
										value={standing()?.id ?? ""}
										onChange={setExpression}
									/>
									<EditorSelect
										label="media"
										options={medias().map((item: any) => String(item.id))}
										value={media()}
										onChange={setMedia}
									/>
								</div>
								<Show when={background()?.background} keyed>
									{(path) => (
										<DraftAsset
											api={props.api}
											files={props.files}
											id={props.id}
											path={path}
											label={background()?.label}
										/>
									)}
								</Show>
								<Show when={standing()?.asset} keyed>
									{(path) => (
										<DraftAsset
											api={props.api}
											files={props.files}
											id={props.id}
											path={path}
											label={standing()?.label}
										/>
									)}
								</Show>
								<Show when={selectedMedia()?.asset} keyed>
									{(path) => (
										<DraftAsset
											api={props.api}
											files={props.files}
											id={props.id}
											path={path}
											captions={selectedMedia()?.captions}
											label={selectedMedia()?.label}
										/>
									)}
								</Show>
								<Show when={steps()[step()]}>
									{(item) => (
										<section>
											<h3>{item().heading}</h3>
											<p>{item().body}</p>
											<blockquote>{item().quote}</blockquote>
											<p>{item().note}</p>
											<Show when={item().kind === "text"}>
												<TextField>
													<TextField.Label>{item().input_label}</TextField.Label>
													<TextField.Input placeholder={item().input_placeholder} />
												</TextField>
											</Show>
											<For each={item().choices ?? []}>
												{(choice) => (
													<Button onClick={() => setStep((step() + 1) % steps().length)}>
														{choice.label} · {choice.description}
													</Button>
												)}
											</For>
											<Button onClick={() => setStep((step() + 1) % steps().length)}>
												{item().submit_label ?? t("studio.nextStep")}
											</Button>
										</section>
									)}
								</Show>
							</>
						}
					>
						<Show when={props.file} keyed>
							{(path) => (
								<DraftAsset
									api={props.api}
									files={props.files}
									id={props.id}
									path={path}
									captions={props.captions}
								/>
							)}
						</Show>
					</Show>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog>
	);
}
