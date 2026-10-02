import { i18n, useTranslation } from "@bear-harness/i18n";
import { createMemo, createSignal, For, Show } from "solid-js";
import { isMap, isNode, parseDocument } from "yaml";
import { Button, Checkbox, TextField } from "../../ui/primitives.js";
import { type EditorSchema, EditorSelect, SchemaFields } from "./SchemaFields.js";

export const formSections = [
	"behavior.examples",
	"character",
	"scenes",
	"visual",
	"media",
	"theme",
	"state_schema",
] as const;
export function PackageForms(props: {
	source: string;
	schema: EditorSchema;
	section: string;
	assets?: string[];
	disabled?: boolean;
	onChange(source: string): void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const doc = createMemo(() => parseDocument(props.source));
	const path = () => props.section.split(".");
	const schema = () => path().reduce((node, key) => node.properties?.[key] ?? {}, props.schema);
	const value = () => {
		const node = doc().getIn(path(), true);
		return isNode(node) ? node.toJSON() : node;
	};
	const change = (value: unknown) => {
		const next = parseDocument(props.source);
		if (next.errors.length || !isMap(next.contents)) return;
		if (value === undefined) next.deleteIn(path());
		else next.setIn(path(), value);
		props.onChange(String(next));
	};
	return (
		<Show
			when={!doc().errors.length && isMap(doc().contents)}
			fallback={<p role="alert">{t("studio.invalidYaml")}</p>}
		>
			<Show
				when={props.section === "state_schema"}
				fallback={
					<SchemaFields
						schema={schema()}
						assets={props.assets}
						path={props.section}
						value={value()}
						disabled={props.disabled}
						onChange={change}
					/>
				}
			>
				<StateFields value={value()} disabled={props.disabled} onChange={change} />
			</Show>
		</Show>
	);
}
function StateFields(props: {
	value: unknown;
	disabled?: boolean;
	onChange(value: unknown): void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const [key, setKey] = createSignal("");
	const root = () =>
		props.value && typeof props.value === "object"
			? (props.value as Record<string, unknown>)
			: {
					$schema: "https://json-schema.org/draft/2020-12/schema",
					type: "object",
					additionalProperties: false,
					properties: {},
				};
	const properties = () => (root().properties as Record<string, Record<string, unknown>>) ?? {};
	const update = (name: string, value: Record<string, unknown> | undefined) => {
		const next = { ...properties() };
		if (value) next[name] = value;
		else delete next[name];
		props.onChange({
			...root(),
			properties: next,
			required: Array.isArray(root().required)
				? (root().required as string[]).filter((k) => k !== name || value)
				: [],
		});
	};
	return (
		<section class="studio-fields">
			<p>{t("studio.stateHint")}</p>
			<For each={Object.keys(properties())}>
				{(name) => (
					<fieldset class="studio-collection-item">
						<legend>{name}</legend>
						<Checkbox
							checked={
								Array.isArray(root().required) && (root().required as string[]).includes(name)
							}
							disabled={props.disabled}
							onChange={(checked) =>
								props.onChange({
									...root(),
									required: checked
										? [
												...new Set([
													...(Array.isArray(root().required) ? (root().required as string[]) : []),
													name,
												]),
											]
										: (Array.isArray(root().required) ? (root().required as string[]) : []).filter(
												(k) => k !== name,
											),
								})
							}
						>
							<Checkbox.Input />
							<Checkbox.Control />
							<Checkbox.Label>{t("studio.required")} · required</Checkbox.Label>
						</Checkbox>
						<EditorSelect
							label={`${name} · x-scope`}
							value={String(properties()[name]?.["x-scope"] ?? "conversation")}
							options={["global", "conversation"]}
							disabled={props.disabled}
							onChange={(value) => update(name, { ...properties()[name], "x-scope": value })}
						/>
						<SchemaFields
							schema={{
								type: "object",
								properties: {
									type: {
										type: "string",
										enum: ["string", "number", "integer", "boolean", "object", "array"],
									},
									title: { type: "string" },
									description: { type: "string" },
									default: {},
									enum: { type: "array", items: {} },
									minimum: { type: "number" },
									maximum: { type: "number" },
									minLength: { type: "integer", minimum: 0 },
									maxLength: { type: "integer", minimum: 0 },
									properties: { type: "object", additionalProperties: {} },
									items: { type: "object", additionalProperties: {} },
									required: { type: "array", items: { type: "string" } },
									additionalProperties: { type: "boolean" },
								},
								required: ["type"],
								additionalProperties: true,
							}}
							path={`state_schema.properties.${name}`}
							value={Object.fromEntries(
								Object.entries(properties()[name] ?? {}).filter(([key]) => key !== "x-scope"),
							)}
							required
							disabled={props.disabled}
							onChange={(value) =>
								update(name, {
									...(value as Record<string, unknown>),
									"x-scope": properties()[name]?.["x-scope"] ?? "conversation",
								})
							}
						/>
						<Button
							disabled={props.disabled}
							onClick={() => {
								if (window.confirm(t("studio.removeItem"))) update(name, undefined);
							}}
						>
							{t("studio.remove")}
						</Button>
					</fieldset>
				)}
			</For>
			<form
				class="studio-tools"
				onSubmit={(event) => {
					event.preventDefault();
					const name = key().trim();
					if (
						name &&
						!Object.hasOwn(properties(), name) &&
						!["__proto__", "constructor", "prototype"].includes(name)
					) {
						update(name, {
							type: "string",
							title: name,
							description: "",
							default: "",
							"x-scope": "conversation",
						});
						setKey("");
					}
				}}
			>
				<TextField value={key()}>
					<TextField.Label>{t("studio.fieldKey")}</TextField.Label>
					<TextField.Input onInput={(event) => setKey(event.currentTarget.value)} />
				</TextField>
				<Button type="submit" disabled={props.disabled || !key().trim()}>
					{t("studio.addItem")}
				</Button>
			</form>
		</section>
	);
}
export function SkillFields(props: {
	source: string;
	schema: EditorSchema;
	disabled?: boolean;
	onChange(source: string): void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const parts = createMemo(() =>
		props.source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/),
	);
	const document = createMemo(() => parseDocument(parts()?.[1] ?? ""));
	return (
		<Show
			when={parts() && !document().errors.length && isMap(document().contents)}
			fallback={<p role="alert">{t("studio.skillFrontmatterHint")}</p>}
		>
			<SchemaFields
				schema={props.schema}
				value={document().toJS()}
				path="SKILL.md"
				required
				disabled={props.disabled}
				onChange={(value) => {
					const doc = parseDocument(parts()?.[1] ?? "");
					const next = value as Record<string, unknown>;
					for (const key of Object.keys(doc.toJS())) if (!Object.hasOwn(next, key)) doc.delete(key);
					for (const [key, value] of Object.entries(next)) doc.set(key, value);
					props.onChange(`---\n${String(doc)}---\n${parts()?.[2] ?? ""}`);
				}}
			/>
			<TextField class="studio-field" value={parts()?.[2] ?? ""} disabled={props.disabled}>
				<TextField.Label>{t("studio.skillBody")}</TextField.Label>
				<TextField.TextArea
					rows={18}
					onInput={(event) =>
						props.onChange(`---\n${parts()?.[1]}\n---\n${event.currentTarget.value}`)
					}
				/>
			</TextField>
		</Show>
	);
}
