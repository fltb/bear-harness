import { Button } from "@kobalte/core/button";
import { createSignal, For, Show } from "solid-js";
import { t } from "./i18n.js";
import { useCompanionStore } from "./stores/companion.js";

export function WorkPanel() {
	const store = useCompanionStore();
	const [busyId, setBusyId] = createSignal<string>();
	const commissions = () =>
		store.commission
			.commissions()
			.filter((item) => !item.conversationId || item.conversationId === store.activeConversationId);
	const artifacts = () => {
		const commissionIds = new Set(commissions().map((commission) => commission.id));
		const runIds = new Set(
			store.runs.filter((run) => commissionIds.has(run.commissionId)).map((run) => run.id),
		);
		return store.artifact
			.artifacts()
			.filter((artifact) => artifact.producerRunId && runIds.has(artifact.producerRunId));
	};
	const visible = () =>
		commissions().some((item) => item.status === "draft" || item.status === "approved") ||
		store.run.pendingPermissions().length > 0 ||
		artifacts().length > 0;
	return (
		<Show when={visible()}>
			<section class="work-panel" aria-label={t("work.title")}>
				<For each={commissions()}>
					{(commission) => (
						<Show when={commission.status === "draft" || commission.status === "approved"}>
							<div class="action-proposal">
								<div>
									<span class="system-label">{t("work.proposal")}</span>
									<h3>{commission.draft.title}</h3>
									<p>{commission.draft.description}</p>
								</div>
								<div class="scope-list">
									<Show when={commission.draft.reads.length > 0}>
										<p>
											<strong>{t("work.reads")}</strong>
											{commission.draft.reads.join("、")}
										</p>
									</Show>
									<Show when={commission.draft.writes.length > 0}>
										<p>
											<strong>{t("work.writes")}</strong>
											{commission.draft.writes.join("、")}
										</p>
									</Show>
									<p>
										<strong>{t("work.network")}</strong>
										{commission.draft.networkAllowed ? t("work.networkYes") : t("work.networkNo")}
									</p>
								</div>
								<div class="work-actions">
									<Button
										data-control="command"
										type="button"
										disabled={busyId() !== undefined}
										onClick={() => {
											setBusyId(commission.id);
											const start =
												commission.status === "draft"
													? store.commission.approve(commission.id, commission.draft.hash)
													: Promise.resolve();
											void start
												.then(() => store.commission.launch(commission.id, "pi-product-managed"))
												.finally(() => setBusyId());
										}}
									>
										{t("work.start")}
									</Button>
									<Button
										data-control="command"
										type="button"
										disabled={busyId() !== undefined}
										onClick={() => void store.commission.reject(commission.id)}
									>
										{t("work.cancel")}
									</Button>
								</div>
							</div>
						</Show>
					)}
				</For>
				<For each={store.run.pendingPermissions()}>
					{(permission) => (
						<div class="action-proposal needs-user">
							<span class="system-label">{t("work.needsYou")}</span>
							<h3>{permission.prompt}</h3>
							<div class="work-actions">
								<For each={permission.options}>
									{(option) => (
										<Button
											data-control="command"
											type="button"
											onClick={() =>
												void store.run.respondPermission(
													permission.runId,
													permission.requestId,
													option.optionId,
												)
											}
										>
											{option.kind.includes("reject") ? t("work.deny") : t("work.allow")}
										</Button>
									)}
								</For>
								<Button
									data-control="command"
									type="button"
									onClick={() => void store.run.cancel(permission.runId)}
								>
									{t("work.stop")}
								</Button>
							</div>
						</div>
					)}
				</For>
				<For each={artifacts()}>
					{(artifact) => (
						<div class="artifact-row">
							<div>
								<strong>{artifact.logicalName}</strong>
								<span>
									{formatBytes(artifact.bytes)} · {t(`work.artifactStatuses.${artifact.status}`)}
								</span>
							</div>
							<Button
								data-control="command"
								type="button"
								onClick={() => void store.artifact.download(artifact.id)}
							>
								{t("work.download")}
							</Button>
						</div>
					)}
				</For>
			</section>
		</Show>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
