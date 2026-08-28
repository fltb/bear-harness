import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { TextField } from "@kobalte/core/text-field";
import { createSignal, For, onMount, Show } from "solid-js";
import { useCompanionStore } from "../stores/companion.js";
import type { ExternalAgentCandidate, ExternalAgentStatusData } from "../stores/ipc.js";

/** Explicit local consent for the optional Codex work agent. */
export function ExternalAgentSettings() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [status, setStatus] = createSignal<ExternalAgentStatusData>();
	const [candidates, setCandidates] = createSignal<ExternalAgentCandidate[]>([]);
	const [codexHome, setCodexHome] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string>();
	const candidateStatus = (candidate: ExternalAgentCandidate) => {
		if (candidate.status === "usable") return t("settings.codexCandidateUsable");
		if (candidate.status === "version_mismatch") return t("settings.codexCandidateVersionMismatch");
		return t("settings.codexCandidateRejected");
	};

	const refresh = async () => {
		setBusy(true);
		setError();
		try {
			const [nextStatus, nextCandidates] = await Promise.all([
				store.externalAgent.status(),
				store.externalAgent.discover(),
			]);
			setStatus(nextStatus);
			setCandidates(nextCandidates);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	const connect = async (candidate: ExternalAgentCandidate) => {
		if (!candidate.canonicalPath || !candidate.version || !candidate.sha256 || !codexHome().trim())
			return;
		setBusy(true);
		setError();
		try {
			await store.externalAgent.connect({
				canonicalPath: candidate.canonicalPath,
				version: candidate.version,
				sha256: candidate.sha256,
				codexHome: codexHome().trim(),
			});
			setStatus(await store.externalAgent.status());
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	onMount(() => void refresh());
	return (
		<section class="model-settings" aria-labelledby="external-agent-settings-heading">
			<div class="settings-group-heading">
				<h3 id="external-agent-settings-heading">{t("settings.workAgent")}</h3>
				<p class="field-hint">{t("settings.workAgentHint")}</p>
			</div>
			<div class="provider-card">
				<div class="settings-group-heading">
					<strong>{t("settings.builtInPiAgent")}</strong>
					<p class="field-hint">{t("settings.builtInPiHint")}</p>
					<Show when={status()?.pi.available === true}>
						<p class="status-line ok">{t("settings.builtInPiReady")}</p>
					</Show>
				</div>
			</div>
			<div class="settings-group-heading">
				<h4>{t("settings.optionalCodexAgent")}</h4>
			</div>
			<Show when={status()?.codex.available === true}>
				<p class="status-line ok">{t("settings.codexConnected")}</p>
			</Show>
			<Show when={status()?.codex.available !== true}>
				<TextField class="field">
					<TextField.Label class="field-label">{t("settings.codexLoginDirectory")}</TextField.Label>
					<TextField.Input
						value={codexHome()}
						onInput={(event) => setCodexHome(event.currentTarget.value)}
						placeholder={t("settings.codexLoginDirectoryPlaceholder")}
					/>
				</TextField>
				<Show when={!busy() && candidates().length === 0}>
					<p class="field-hint">{t("settings.codexNotFound")}</p>
				</Show>
				<For each={candidates().filter((candidate) => candidate.status !== "not_found")}>
					{(candidate) => (
						<div class="provider-card">
							<div class="settings-group-heading">
								<strong>{candidate.candidatePath}</strong>
								<p class="field-hint">{candidate.version ?? t("settings.codexUnknownVersion")}</p>
								<p class={candidate.status === "usable" ? "status-line ok" : "status-line err"}>
									{candidateStatus(candidate)}
								</p>
							</div>
							<Button
								type="button"
								disabled={busy() || candidate.status !== "usable" || !codexHome().trim()}
								onClick={() => void connect(candidate)}
							>
								{t("settings.connectCodex")}
							</Button>
						</div>
					)}
				</For>
			</Show>
			<Button type="button" disabled={busy()} onClick={() => void refresh()}>
				{busy() ? t("settings.loading") : t("settings.refreshCodex")}
			</Button>
			<Show when={error()}>{(message) => <p class="status-line err">{message()}</p>}</Show>
		</section>
	);
}
