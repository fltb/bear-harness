import { productUi } from "@bear-harness/product-config";
import { createSignal, For, Show } from "solid-js";
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
			<section class="work-panel" aria-label={productUi.work.title}>
				<For each={commissions()}>
					{(commission) => (
						<Show when={commission.status === "draft" || commission.status === "approved"}>
							<div class="action-proposal">
								<div>
									<span class="system-label">{productUi.work.proposal}</span>
									<h3>{commission.draft.title}</h3>
									<p>{commission.draft.description}</p>
								</div>
								<div class="scope-list">
									<Show when={commission.draft.reads.length > 0}>
										<p>
											<strong>{productUi.work.reads}</strong>
											{commission.draft.reads.join("、")}
										</p>
									</Show>
									<Show when={commission.draft.writes.length > 0}>
										<p>
											<strong>{productUi.work.writes}</strong>
											{commission.draft.writes.join("、")}
										</p>
									</Show>
									<p>
										<strong>{productUi.work.network}</strong>
										{commission.draft.networkAllowed
											? productUi.work.networkYes
											: productUi.work.networkNo}
									</p>
								</div>
								<div class="work-actions">
									<button
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
										{productUi.work.start}
									</button>
									<button
										type="button"
										disabled={busyId() !== undefined}
										onClick={() => void store.commission.reject(commission.id)}
									>
										{productUi.work.cancel}
									</button>
								</div>
							</div>
						</Show>
					)}
				</For>
				<For each={store.run.pendingPermissions()}>
					{(permission) => (
						<div class="action-proposal needs-user">
							<span class="system-label">{productUi.work.needsYou}</span>
							<h3>{permission.prompt}</h3>
							<div class="work-actions">
								<For each={permission.options}>
									{(option) => (
										<button
											type="button"
											onClick={() =>
												void store.run.respondPermission(
													permission.runId,
													permission.requestId,
													option.optionId,
												)
											}
										>
											{option.kind.includes("reject") ? productUi.work.deny : productUi.work.allow}
										</button>
									)}
								</For>
								<button type="button" onClick={() => void store.run.cancel(permission.runId)}>
									{productUi.work.stop}
								</button>
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
									{formatBytes(artifact.bytes)} · {productUi.work.artifactStatuses[artifact.status]}
								</span>
							</div>
							<button type="button" onClick={() => void store.artifact.download(artifact.id)}>
								{productUi.work.download}
							</button>
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
