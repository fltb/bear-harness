import { i18n, useTranslation } from "@bear-harness/i18n";
import { type JsonSchema, resolveSchema } from "@jsonforms/core";
import { createMemo, createSignal, For, Show } from "solid-js";
import { useCompanionStore } from "./stores/companion.js";
import type { CharacterStateDocument, CompanionStateChange } from "./stores/ipc.js";
import { Button, Dialog, Select, TextField } from "./ui/primitives.js";

type SchemaNode = JsonSchema & {
	$ref?: string;
	title?: string;
	description?: string;
	readOnly?: boolean;
	properties?: Record<string, SchemaNode>;
	oneOf?: Array<SchemaNode & { const?: unknown }>;
	"x-user-editable"?: boolean;
};

export function ConversationStatePanel(props: {
	open: boolean;
	onOpenChange(open: boolean): void;
}) {
	const store = useCompanionStore();
	const [t] = useTranslation(undefined, { i18n });
	const projection = createMemo(() => store.companionState?.state.character);
	const schema = createMemo(() => store.companionState?.schema as SchemaNode | undefined);

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay class="conversation-state-overlay" />
				<Dialog.Content class="conversation-state-panel">
					<header class="conversation-state-head">
						<div>
							<Dialog.Title>{schema()?.title ?? t("conversationState.title")}</Dialog.Title>
							<Dialog.Description>
								{schema()?.description ?? t("conversationState.description")}
							</Dialog.Description>
						</div>
						<Button
							type="button"
							class="conversation-state-close"
							onClick={() => props.onOpenChange(false)}
						>
							{t("conversationState.close")}
						</Button>
					</header>
					<Show when={projection()} keyed>
						{(current) => (
							<Show when={schema()}>
								{(root) => <StateEditor projection={current} schema={root()} />}
							</Show>
						)}
					</Show>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog>
	);
}

function StateEditor(props: { projection: CharacterStateDocument; schema: SchemaNode }) {
	const store = useCompanionStore();
	const [t] = useTranslation(undefined, { i18n });
	const [draft, setDraft] = createSignal(
		JSON.parse(JSON.stringify(props.projection.document)) as Record<string, unknown>,
	);
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal<string>();
	const changes = createMemo<CompanionStateChange[]>(() => {
		const collected: CompanionStateChange[] = [];
		collectEditableChanges(
			props.schema,
			props.schema,
			"/character",
			props.projection.document,
			draft(),
			collected,
		);
		return collected;
	});
	const save = async () => {
		if (changes().length === 0) return;
		setSaving(true);
		setError(undefined);
		try {
			await store.updateCompanionState(changes());
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};
	return (
		<>
			<div class="conversation-state-scroll">
				<SchemaFields
					schema={props.schema}
					root={props.schema}
					pointer=""
					value={draft()}
					depth={0}
					onChange={(pointer, value) => setDraftValue(setDraft, pointer, value)}
				/>
			</div>
			<footer class="conversation-state-actions">
				<span>
					{t("conversationState.revision")} {props.projection.revisions.conversation}
				</span>
				<Show when={error()}>{(message) => <span role="alert">{message()}</span>}</Show>
				<Button
					type="button"
					disabled={saving() || changes().length === 0}
					onClick={() => void save()}
				>
					{saving() ? t("conversationState.saving") : t("conversationState.save")}
				</Button>
			</footer>
		</>
	);
}

function SchemaFields(props: {
	schema: SchemaNode;
	root: SchemaNode;
	pointer: string;
	value: unknown;
	depth: number;
	onChange(pointer: string, value: unknown): void;
}) {
	const resolved = () => resolveNode(props.schema, props.root);
	const properties = () => resolved().properties ?? {};
	return (
		<div class="conversation-state-fields">
			<For each={Object.entries(properties())}>
				{([name, child]) => {
					const pointer = `${props.pointer}/${escapePointer(name)}`;
					const value = () =>
						props.value && typeof props.value === "object" && !Array.isArray(props.value)
							? (props.value as Record<string, unknown>)[name]
							: undefined;
					const node = () => resolveNode(child, props.root);
					return (
						<Show
							when={node().type !== "object" && !node().properties}
							fallback={
								<section class="conversation-state-group">
									<Show when={props.depth === 0} fallback={<h4>{node().title ?? name}</h4>}>
										<h3>{node().title ?? name}</h3>
									</Show>
									<Show when={node().description}>
										<p>{node().description}</p>
									</Show>
									<SchemaFields
										schema={node()}
										root={props.root}
										pointer={pointer}
										value={value()}
										depth={props.depth + 1}
										onChange={props.onChange}
									/>
								</section>
							}
						>
							<StateControl
								schema={node()}
								pointer={pointer}
								value={value()}
								onChange={props.onChange}
							/>
						</Show>
					);
				}}
			</For>
		</div>
	);
}

function StateControl(props: {
	schema: SchemaNode;
	pointer: string;
	value: unknown;
	onChange(pointer: string, value: unknown): void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const editable = () => props.schema["x-user-editable"] === true && props.schema.readOnly !== true;
	const options = () =>
		(
			props.schema.oneOf ??
			(props.schema.type === "boolean"
				? [
						{ const: true, title: t("conversationState.enabled") },
						{ const: false, title: t("conversationState.disabled") },
					]
				: [])
		)
			.filter((option) => option.const !== undefined)
			.map((option) => ({ value: option.const, label: option.title ?? String(option.const) }));
	return (
		<div class="conversation-state-field">
			<div class="conversation-state-field-copy">
				<strong>{props.schema.title ?? props.pointer.split("/").at(-1)}</strong>
				<Show when={props.schema.description}>{(description) => <span>{description()}</span>}</Show>
			</div>
			<Show
				when={editable()}
				fallback={
					<output>
						{displayValue(
							props.value,
							options(),
							t("conversationState.empty"),
							t("conversationState.enabled"),
							t("conversationState.disabled"),
						)}
					</output>
				}
			>
				<Show
					when={options().length > 0}
					fallback={
						<TextField>
							<Show
								when={props.schema.type === "array"}
								fallback={
									<TextField.Input
										value={String(props.value ?? "")}
										onInput={(event) =>
											props.onChange(
												props.pointer,
												props.schema.type === "number" || props.schema.type === "integer"
													? Number(event.currentTarget.value)
													: event.currentTarget.value,
											)
										}
									/>
								}
							>
								<TextField.TextArea
									value={Array.isArray(props.value) ? props.value.join("\n") : ""}
									onInput={(event) =>
										props.onChange(
											props.pointer,
											event.currentTarget.value.split("\n").filter(Boolean),
										)
									}
								/>
							</Show>
						</TextField>
					}
				>
					<Select
						options={options()}
						optionValue="value"
						optionTextValue="label"
						value={options().find((option) => Object.is(option.value, props.value))}
						onChange={(option) => option && props.onChange(props.pointer, option.value)}
						itemComponent={(itemProps) => (
							<Select.Item item={itemProps.item} class="select-item">
								<Select.ItemLabel>{itemProps.item.rawValue.label}</Select.ItemLabel>
							</Select.Item>
						)}
					>
						<Select.Trigger class="select-trigger">
							<Select.Value<{ value: unknown; label: string }> class="select-value" />
						</Select.Trigger>
						<Select.Portal>
							<Select.Content class="select-content">
								<Select.Listbox class="select-listbox" />
							</Select.Content>
						</Select.Portal>
					</Select>
				</Show>
			</Show>
		</div>
	);
}

function resolveNode(schema: SchemaNode, root: SchemaNode): SchemaNode {
	if (!schema.$ref) return schema;
	return (resolveSchema(root, schema.$ref, root) as SchemaNode | undefined) ?? schema;
}

function collectEditableChanges(
	schema: SchemaNode,
	root: SchemaNode,
	pointer: string,
	current: unknown,
	draft: unknown,
	changes: CompanionStateChange[],
): void {
	const node = resolveNode(schema, root);
	if (node.type === "object" || node.properties) {
		for (const [name, child] of Object.entries(node.properties ?? {}))
			collectEditableChanges(
				child,
				root,
				`${pointer}/${escapePointer(name)}`,
				objectValue(current, name),
				objectValue(draft, name),
				changes,
			);
		return;
	}
	if (node["x-user-editable"] !== true || node.readOnly === true) return;
	if (JSON.stringify(current) !== JSON.stringify(draft))
		changes.push({ path: pointer, value: draft as never });
}

function setDraftValue(
	setDraft: (updater: (current: Record<string, unknown>) => Record<string, unknown>) => void,
	pointer: string,
	value: unknown,
): void {
	setDraft((current) => {
		const next = structuredClone(current);
		const segments = pointer.slice(1).split("/").map(unescapePointer);
		let target = next;
		for (const segment of segments.slice(0, -1)) {
			target[segment] ??= {};
			target = target[segment] as Record<string, unknown>;
		}
		const last = segments.at(-1);
		if (last) target[last] = value;
		return next;
	});
}

function objectValue(value: unknown, key: string): unknown {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;
}
function displayValue(
	value: unknown,
	options: Array<{ value: unknown; label: string }>,
	empty: string,
	enabled: string,
	disabled: string,
): string {
	const option = options.find((candidate) => Object.is(candidate.value, value));
	if (option) return option.label;
	if (Array.isArray(value)) return value.length ? value.join("、") : empty;
	if (typeof value === "boolean") return value ? enabled : disabled;
	return value === undefined || value === null || value === "" ? empty : String(value);
}
function escapePointer(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
function unescapePointer(value: string): string {
	return value.replaceAll("~1", "/").replaceAll("~0", "~");
}
