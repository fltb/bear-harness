import { i18n, useTranslation } from "@bear-harness/i18n";
import type { MemoryInspectRequest, MemoryInspectResponse } from "@bear-harness/protocol";
import { createMutation, createQuery, useQueryClient } from "@tanstack/solid-query";
import { type Accessor, batch, createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { MessageContent } from "../MessageContent.js";
import { Button, Checkbox } from "../ui/primitives.js";

type MemoryReader = (request: MemoryInspectRequest) => Promise<MemoryInspectResponse>;
interface MemoryConsentProps {
	memoryGet(characterId: string): Promise<{ enabled: boolean }>;
	memorySet(characterId: string, enabled: boolean): Promise<{ enabled: boolean }>;
	systemMemoryEnabled: Accessor<boolean>;
}

export function RelationshipMemory(
	props: {
		characterId: Accessor<string | undefined>;
		characterName: Accessor<string>;
		load: MemoryReader;
		onSystemSettings?: () => void;
	} & MemoryConsentProps,
) {
	const [t] = useTranslation(undefined, { i18n });
	const [open, setOpen] = createSignal(false);
	const contentId = createUniqueId();
	return (
		<section class="memory-section">
			<Show when={props.characterId()} keyed>
				{(characterId) => (
					<MemoryConsent
						characterId={characterId}
						characterName={props.characterName()}
						memoryGet={props.memoryGet}
						memorySet={props.memorySet}
						systemMemoryEnabled={props.systemMemoryEnabled}
						onSystemSettings={props.onSystemSettings}
					/>
				)}
			</Show>
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
						/>
					)}
				</Show>
			</div>
		</section>
	);
}

export function MemoryConsent(
	props: MemoryConsentProps & {
		characterId: string;
		characterName: string;
		onSystemSettings?: () => void;
		children?: (pending: Accessor<boolean>) => JSX.Element;
	},
) {
	const [t] = useTranslation(undefined, { i18n });
	const client = useQueryClient();
	const queryKey = ["character", "memoryConsent", props.characterId] as const;
	const query = createQuery(() => ({
		queryKey,
		queryFn: () => props.memoryGet(props.characterId),
		retry: false,
		staleTime: 0,
		gcTime: 0,
	}));
	const mutation = createMutation(() => ({
		mutationFn: (enabled: boolean) => props.memorySet(props.characterId, enabled),
		onSuccess: (value: { enabled: boolean }) => {
			client.setQueryData(queryKey, value);
			void client.invalidateQueries({ queryKey: ["character", "memory", props.characterId] });
		},
	}));
	return (
		<>
			<div class="memory-entry">
				<Checkbox
					class="settings-checkbox"
					checked={query.data?.enabled === true}
					disabled={
						query.isPending ||
						mutation.isPending ||
						Boolean(query.error) ||
						(!props.systemMemoryEnabled() && query.data?.enabled !== true)
					}
					onChange={(enabled) => mutation.mutate(enabled)}
				>
					<Checkbox.Input />
					<Checkbox.Control class="settings-checkbox-control">
						<Checkbox.Indicator>✓</Checkbox.Indicator>
					</Checkbox.Control>
					<Checkbox.Label>
						{t("relationshipMemory.consentLabel", { name: props.characterName })}
					</Checkbox.Label>
				</Checkbox>
				<p class="memory-note">{t("relationshipMemory.consentDescription")}</p>
				<Show when={!props.systemMemoryEnabled()}>
					<p class="memory-note">{t("relationshipMemory.systemRequired")}</p>
					<Show when={props.onSystemSettings}>
						{(openSettings) => (
							<Button type="button" onClick={() => openSettings()()}>
								{t("relationshipMemory.systemSettings")}
							</Button>
						)}
					</Show>
				</Show>
				<Show when={query.error || mutation.error}>
					<p role="alert" class="status-line err">
						{t("relationshipMemory.consentError")}
					</p>
					<Show when={query.error}>
						<Button type="button" onClick={() => void query.refetch()}>
							{t("relationshipMemory.refresh")}
						</Button>
					</Show>
				</Show>
			</div>
			{props.children?.(() => query.isPending || mutation.isPending)}
		</>
	);
}

function MemoryPage(props: { characterId: string; characterName: string; load: MemoryReader }) {
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
