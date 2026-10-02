import { i18n, useTranslation } from "@bear-harness/i18n";
import type { CharacterDraft, CharacterDraftReviewResponse } from "@bear-harness/protocol";
import { createResource, createSignal, For, Show } from "solid-js";
import type { CharacterApi } from "../../stores/supplementary-api.js";
import { Button, TextField } from "../../ui/primitives.js";
export function StudioReview(props: {
	draft: CharacterDraft;
	review: CharacterDraftReviewResponse;
	api: CharacterApi;
	onFile(path: string, field: string): void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const [path, setPath] = createSignal<string>();
	const [diff] = createResource(path, (file) =>
		props.api.draftDiff(props.draft.id, props.draft.currentRevision, file),
	);
	const data = () => (diff.error ? undefined : diff());
	return (
		<div class="studio-review">
			<Show when={props.review.issues.length}>
				<h3>{t("studio.issues")}</h3>
				<For each={props.review.issues}>
					{(issue) => (
						<div class="studio-issue">
							<Button onClick={() => props.onFile(issue.file, issue.path)}>
								{issue.file}
								{issue.path ? ` · ${issue.path}` : ""}
							</Button>
							<p>{issue.message}</p>
						</div>
					)}
				</For>
			</Show>
			<h3>{t("studio.changes")}</h3>
			<Show when={props.review.changes.length} fallback={<p>{t("studio.noChanges")}</p>}>
				<For each={props.review.changes}>
					{(change) => (
						<Button onClick={() => setPath(change.path)}>
							{t(`studio.${change.kind}`)} · {change.path}
							{change.binary ? ` · ${t("studio.binary")}` : ""}
						</Button>
					)}
				</For>
			</Show>
			<Show when={diff.loading}>
				<p role="status">{t("studio.loading")}</p>
			</Show>
			<Show when={diff.error}>
				<p role="alert">{String(diff.error)}</p>
			</Show>
			<Show when={data()}>
				{(value) => (
					<>
						<h3>{path()}</h3>
						<Show when={value().truncated}>
							<p>{t("studio.diffTruncated")}</p>
						</Show>
						<div class="studio-diff">
							<TextField value={value().before} readOnly>
								<TextField.Label>{t("studio.installed")}</TextField.Label>
								<TextField.TextArea rows={14} />
							</TextField>
							<TextField value={value().after} readOnly>
								<TextField.Label>{t("studio.draftVersion")}</TextField.Label>
								<TextField.TextArea rows={14} />
							</TextField>
						</div>
					</>
				)}
			</Show>
		</div>
	);
}
