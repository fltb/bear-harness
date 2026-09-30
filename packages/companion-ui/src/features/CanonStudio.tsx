import { i18n, useTranslation } from "@bear-harness/i18n";
import { For, Show } from "solid-js";
import { createBackstageWorkflowStore } from "../stores/backstage-workflows.js";
import { useCompanionStore } from "../stores/companion.js";
import { Button, TextField } from "../ui/primitives.js";

export function CanonStudio() {
	const [t] = useTranslation(undefined, { i18n });
	const companion = useCompanionStore();
	const workflow = createBackstageWorkflowStore(companion);
	const state = workflow.canon();

	return (
		<div class="canon-studio">
			<p class="drawer-note">{t("canonStudio.note")}</p>
			<section>
				<h3>{t("canonStudio.sources")}</h3>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						state.addSource();
					}}
				>
					<TextField class="setting-field">
						<TextField.Input
							aria-label={t("canonStudio.sourceName")}
							placeholder={t("canonStudio.sourceName")}
							value={state.sourceName()}
							onInput={(event) => state.setSourceName(event.currentTarget.value)}
						/>
					</TextField>
					<TextField class="setting-field">
						<TextField.TextArea
							rows={7}
							aria-label={t("canonStudio.sourceText")}
							placeholder={t("canonStudio.sourceText")}
							value={state.sourceText()}
							onInput={(event) => state.setSourceText(event.currentTarget.value)}
						/>
					</TextField>
					<Button
						data-control="command"
						type="submit"
						disabled={state.busy() || !state.sourceName().trim() || !state.sourceText().trim()}
					>
						{t("canonStudio.addSource")}
					</Button>
				</form>
				<For each={state.sources()}>
					{(source) => (
						<div class="canon-row">
							<div>
								<strong>{source.logicalName}</strong>
								<span>
									{source.chunkCount} {t("canonStudio.chunks")}
								</span>
								<Show when={source.origin === "package"}>
									<span>{t("canonStudio.packageManaged")}</span>
								</Show>
								<Show when={source.language}>
									<span>
										{t("canonStudio.sourceLanguage", { language: source.language ?? "" })}
									</span>
								</Show>
							</div>
							<Show when={source.origin !== "package"}>
								<Button
									data-control="command"
									type="button"
									aria-label={`${t("canonStudio.remove")} ${source.logicalName}`}
									onClick={() => {
										if (window.confirm(t("canonStudio.removeConfirm")))
											state.removeSource(source.id);
									}}
								>
									{t("canonStudio.remove")}
								</Button>
							</Show>
						</div>
					)}
				</For>
			</section>
			<section>
				<h3>{t("canonStudio.search")}</h3>
				<form
					class="canon-search"
					onSubmit={(event) => {
						event.preventDefault();
						state.search();
					}}
				>
					<TextField class="setting-field">
						<TextField.Input
							aria-label={t("canonStudio.search")}
							value={state.query()}
							onInput={(event) => state.setQuery(event.currentTarget.value)}
						/>
					</TextField>
					<Button data-control="command" type="submit">
						{t("canonStudio.search")}
					</Button>
				</form>
				<For each={state.results()}>
					{(chunk) => (
						<div class="canon-result">
							<strong>
								{chunk.sourceName} · {chunk.ordinal + 1}
							</strong>
							<p>{chunk.content}</p>
						</div>
					)}
				</For>
			</section>
		</div>
	);
}
