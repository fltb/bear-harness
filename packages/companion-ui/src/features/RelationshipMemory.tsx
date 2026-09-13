import { i18n, useTranslation } from "@bear-harness/i18n";
import type { MemoryInspectRequest, MemoryInspectResponse } from "@bear-harness/protocol";
import { createQuery } from "@tanstack/solid-query";
import { type Accessor, batch, createSignal, createUniqueId, For, Show } from "solid-js";
import { MessageContent } from "../MessageContent.js";
import { Button } from "../ui/primitives.js";

type MemoryReader = (request: MemoryInspectRequest) => Promise<MemoryInspectResponse>;

export function RelationshipMemory(props: {
	characterId: Accessor<string | undefined>;
	characterName: Accessor<string>;
	load: MemoryReader;
	onSystemSettings?: () => void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const [open, setOpen] = createSignal(false);
	const contentId = createUniqueId();
	return (
		<section class="memory-section">
			<div class="memory-actions">
				<Button
					type="button"
					aria-expanded={open()}
					aria-controls={contentId}
					disabled={!props.characterId()}
					onClick={() => setOpen((value) => !value)}
				>
					{t("relationshipMemory.title")}
				</Button>
			</div>
			<div id={contentId}>
				<Show when={open() ? props.characterId() : undefined} keyed>
					{(characterId) => (
						<MemoryPage
							characterId={characterId}
							characterName={props.characterName()}
							load={props.load}
							onSystemSettings={props.onSystemSettings}
						/>
					)}
				</Show>
			</div>
		</section>
	);
}

function MemoryPage(props: {
	characterId: string;
	characterName: string;
	load: MemoryReader;
	onSystemSettings?: () => void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const [kind, setKind] = createSignal<MemoryInspectRequest["kind"]>("records");
	const [offset, setOffset] = createSignal(0);
	const limit = 20;
	let panel: HTMLDivElement | undefined;
	const changePage = (next: number) => {
		setOffset(next);
		panel?.scrollIntoView?.({ block: "start", behavior: "instant" });
	};
	const query = createQuery(() => {
		const request = { characterId: props.characterId, kind: kind(), offset: offset(), limit };
		return {
			queryKey: ["character", "memory", request.characterId, request.kind, request.offset],
			queryFn: async () => {
				const data = await props.load(request);
				if (
					data.characterId !== request.characterId ||
					(request.kind === "explicit" && typeof data.explicit !== "string")
				) {
					throw new Error("Character memory response does not match its request");
				}
				return data;
			},
			staleTime: 0,
			gcTime: 0,
			retry: false,
			refetchOnMount: "always" as const,
			refetchOnWindowFocus: false,
		};
	});
	const tabs = () => [
		{ id: "records" as const, label: t("relationshipMemory.records") },
		{ id: "profiles" as const, label: t("relationshipMemory.profiles") },
		{ id: "explicit" as const, label: t("relationshipMemory.explicitTitle") },
	];
	return (
		<div ref={panel} class="memory-entry" data-memory-character={props.characterId}>
			<p class="memory-note">
				{t("relationshipMemory.description", { name: props.characterName })}
			</p>
			<div class="memory-actions">
				<For each={tabs()}>
					{(tab) => (
						<Button
							type="button"
							aria-pressed={kind() === tab.id}
							onClick={() =>
								batch(() => {
									setKind(tab.id);
									setOffset(0);
								})
							}
						>
							{tab.label}
						</Button>
					)}
				</For>
				<Button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
					{t("relationshipMemory.refresh")}
				</Button>
			</div>
			<Show when={query.isPending}>
				<p class="status-line" role="status">
					{t("relationshipMemory.loading")}
				</p>
			</Show>
			<Show when={query.error}>
				<p class="status-line err" role="alert">
					{t("relationshipMemory.error")}
				</p>
			</Show>
			<Show when={!query.error && query.data} keyed>
				{(data) => (
					<>
						<Show when={!data.relationshipMemoryEnabled && kind() !== "explicit"}>
							<p class="memory-note">{t("relationshipMemory.disabled")}</p>
							<Show when={props.onSystemSettings}>
								{(openSettings) => (
									<div class="memory-actions">
										<Button type="button" onClick={() => openSettings()()}>
											{t("relationshipMemory.systemSettings")}
										</Button>
									</div>
								)}
							</Show>
						</Show>
						<Show
							when={kind() === "explicit"}
							fallback={
								<>
									<Show
										when={data.items.length > 0}
										fallback={<p class="memory-note">{t("relationshipMemory.empty")}</p>}
									>
										<ul class="memory-items">
											<For each={data.items}>
												{(item) => (
													<li class="memory-entry" data-memory-id={item.id}>
														<header>
															<strong>
																{item.type === "l3"
																	? t("relationshipMemory.persona")
																	: item.sceneName || item.type}
															</strong>
															<time dateTime={item.updatedAt}>
																{t("relationshipMemory.updated", {
																	time: new Date(item.updatedAt).toLocaleString(),
																})}
															</time>
														</header>
														<MessageContent text={item.content} format="markdown" />
														<Show when={item.sessionId}>
															<footer>
																<span>{t("relationshipMemory.source")}</span>
																<code>{item.sessionId}</code>
															</footer>
														</Show>
													</li>
												)}
											</For>
										</ul>
									</Show>
									<div class="memory-actions">
										<Button
											type="button"
											disabled={offset() === 0 || query.isFetching}
											onClick={() => changePage(Math.max(0, offset() - limit))}
										>
											{t("relationshipMemory.previous")}
										</Button>
										<Button
											type="button"
											disabled={data.nextOffset === undefined || query.isFetching}
											onClick={() => data.nextOffset !== undefined && changePage(data.nextOffset)}
										>
											{t("relationshipMemory.next")}
										</Button>
									</div>
								</>
							}
						>
							<p class="memory-note">{t("relationshipMemory.explicitDescription")}</p>
							<MessageContent
								text={data.explicit || t("relationshipMemory.explicitEmpty")}
								format="plain"
							/>
						</Show>
					</>
				)}
			</Show>
		</div>
	);
}
