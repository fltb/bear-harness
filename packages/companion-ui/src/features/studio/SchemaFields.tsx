import { i18n, useTranslation } from "@bear-harness/i18n";
import { createMemo, createSignal, For, Index, Show } from "solid-js";
import { Button, Select, TextField } from "../../ui/primitives.js";

export type EditorSchema = {
	type?: string;
	const?: unknown;
	enum?: unknown[];
	properties?: Record<string, EditorSchema>;
	additionalProperties?: boolean | EditorSchema;
	items?: EditorSchema;
	required?: string[];
	anyOf?: EditorSchema[];
	oneOf?: EditorSchema[];
	default?: unknown;
	minimum?: number;
	maximum?: number;
	minItems?: number;
	maxItems?: number;
	description?: string;
};
export function defaultValue(schema: EditorSchema): unknown {
	if (schema.default !== undefined && schema.default !== null)
		return structuredClone(schema.default);
	if (schema.const !== undefined) return schema.const;
	if (schema.enum) return schema.enum[0];
	if (schema.anyOf || schema.oneOf)
		return defaultValue((schema.anyOf ?? schema.oneOf)?.find((s) => s.type !== "null") ?? {});
	if (schema.type === "array")
		return Array.from({ length: schema.minItems ?? 0 }, () => defaultValue(schema.items ?? {}));
	if (schema.type === "object")
		return Object.fromEntries(
			(schema.required ?? []).map((key) => [key, defaultValue(schema.properties?.[key] ?? {})]),
		);
	if (schema.type === "boolean") return false;
	if (schema.type === "number" || schema.type === "integer") return schema.minimum ?? 0;
	return "";
}
export function EditorSelect(props: {
	label: string;
	value: string;
	options: string[];
	disabled?: boolean;
	onChange(value: string): void;
}) {
	return (
		<Select<string>
			class="studio-field"
			options={props.options}
			value={props.value || null}
			disabled={props.disabled}
			onChange={(value) => {
				if (value !== null && value !== props.value) props.onChange(value);
			}}
			itemComponent={(item) => (
				<Select.Item item={item.item} class="select-item">
					<Select.ItemLabel>{item.item.rawValue}</Select.ItemLabel>
				</Select.Item>
			)}
		>
			<Select.Label>{props.label}</Select.Label>
			<Select.Trigger class="select-trigger" aria-label={props.label}>
				<Select.Value<string>>{(state) => state.selectedOption()}</Select.Value>
			</Select.Trigger>
			<Select.Portal>
				<Select.Content class="select-content">
					<Select.Listbox class="select-listbox" />
				</Select.Content>
			</Select.Portal>
		</Select>
	);
}
export function SchemaFields(props: {
	schema: EditorSchema;
	assets?: string[];
	value: unknown;
	path: string;
	required?: boolean;
	disabled?: boolean;
	onChange(value: unknown): void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const [newKey, setNewKey] = createSignal("");
	const [jsonError, setJsonError] = createSignal("");
	const [jsonInput, setJsonInput] = createSignal<string>();
	const variants = () => props.schema.oneOf ?? props.schema.anyOf ?? [];
	const discriminator = (variant: EditorSchema) =>
		Object.entries(variant.properties ?? {}).find(([, field]) => field.const !== undefined);
	const object = (): Record<string, unknown> =>
		props.value && typeof props.value === "object" && !Array.isArray(props.value)
			? (props.value as Record<string, unknown>)
			: {};
	const selectedVariant = createMemo(
		() =>
			variants().find((variant) => {
				const key = discriminator(variant);
				return key && object()[key[0]] === key[1].const;
			}) ??
			variants().find((v) => v.type === typeof props.value) ??
			variants().find((v) => v.type !== "null"),
	);
	const dynamic = () =>
		!selectedVariant() &&
		!props.schema.type &&
		!props.schema.properties &&
		!props.schema.enum &&
		props.schema.const === undefined;
	const schema = (): EditorSchema =>
		selectedVariant() ??
		(dynamic()
			? {
					...props.schema,
					type: Array.isArray(props.value)
						? "array"
						: props.value === null
							? "string"
							: typeof props.value === "undefined"
								? "string"
								: typeof props.value,
				}
			: props.schema);
	const values = () => (Array.isArray(props.value) ? props.value : []);
	const keys = createMemo(() => [
		...new Set([...Object.keys(schema().properties ?? {}), ...Object.keys(object())]),
	]);
	const fieldName = () => props.path.split(".").at(-1) ?? props.path;
	const labels = () => t("studio.fieldNames", { returnObjects: true }) as Record<string, string>;
	const label = () =>
		`${labels()[fieldName()] ?? fieldName()} · ${props.path}${props.required ? ` ${t("studio.required")}` : ""}`;
	const update = (key: string, value: unknown) => {
		const next = { ...object() };
		if (value === undefined) delete next[key];
		else next[key] = value;
		props.onChange(next);
	};
	function reorder(index: number, delta: number) {
		const next = [...values()];
		const item = next.splice(index, 1)[0];
		next.splice(index + delta, 0, item);
		props.onChange(next);
	}
	return (
		<section class="studio-schema-field" aria-label={props.path}>
			<Show
				when={(props.value !== undefined && props.value !== null) || props.required}
				fallback={
					<Button
						disabled={props.disabled}
						onClick={() => props.onChange(defaultValue(props.schema))}
					>
						{t("studio.addField", { field: label() })}
					</Button>
				}
			>
				<Show when={variants().some((v) => v.type === "null")}>
					<Button
						disabled={props.disabled}
						onClick={() => props.onChange(props.value === null ? defaultValue(props.schema) : null)}
					>
						{props.value === null ? t("studio.setValue") : t("studio.setNull")}
					</Button>
				</Show>
				<Show
					when={
						variants().filter((v) => v.type && v.type !== "null" && !discriminator(v)).length > 1
					}
				>
					<EditorSelect
						label={`${label()} · ${t("studio.valueType")}`}
						value={schema().type ?? "string"}
						options={variants().flatMap((v) => (v.type && v.type !== "null" ? [v.type] : []))}
						disabled={props.disabled}
						onChange={(type) =>
							props.onChange(defaultValue(variants().find((v) => v.type === type) ?? {}))
						}
					/>
				</Show>
				<Show
					when={
						props.assets?.length &&
						["asset", "background", "avatar", "poster", "captions"].includes(fieldName())
					}
				>
					<EditorSelect
						label={`${label()} · ${t("studio.chooseAsset")}`}
						options={props.assets ?? []}
						value={typeof props.value === "string" ? props.value : ""}
						disabled={props.disabled}
						onChange={props.onChange}
					/>
				</Show>
				<Show when={dynamic()}>
					<EditorSelect
						label={`${label()} · ${t("studio.valueType")}`}
						value={schema().type ?? "string"}
						options={["string", "number", "boolean", "object", "array"]}
						disabled={props.disabled}
						onChange={(type) => {
							if (window.confirm(t("studio.changeKind"))) props.onChange(defaultValue({ type }));
						}}
					/>
				</Show>
				<Show when={variants().filter((v) => discriminator(v)).length > 1}>
					<EditorSelect
						label={`${label()} · ${t("studio.variant")}`}
						value={String(discriminator(schema())?.[1].const ?? "")}
						options={variants().flatMap((v) => {
							const key = discriminator(v);
							return key ? [String(key[1].const)] : [];
						})}
						disabled={props.disabled}
						onChange={(value) => {
							const variant = variants().find((v) => String(discriminator(v)?.[1].const) === value);
							if (variant && window.confirm(t("studio.changeKind"))) {
								const next = defaultValue(variant) as Record<string, unknown>;
								for (const key of Object.keys(variant.properties ?? {}))
									if (object()[key] !== undefined && variant.properties?.[key]?.const === undefined)
										next[key] = object()[key];
								props.onChange(next);
							}
						}}
					/>
				</Show>
				<Show
					when={schema().const === undefined}
					fallback={
						<p>
							<code>{props.path}</code>: {String(schema().const)}
						</p>
					}
				>
					<Show
						when={schema().type === "object" || schema().properties}
						fallback={
							<Show
								when={schema().type === "array"}
								fallback={
									<Show
										when={schema().enum || schema().type === "boolean"}
										fallback={
											<Show
												when={["string", "number", "integer"].includes(schema().type ?? "")}
												fallback={
													<TextField
														class="studio-field"
														value={jsonInput() ?? JSON.stringify(props.value, null, 2)}
														disabled={props.disabled}
													>
														<TextField.Label>{label()} · JSON</TextField.Label>
														<TextField.TextArea
															rows={6}
															onInput={(event) => {
																const value = event.currentTarget.value;
																setJsonInput(value);
																try {
																	props.onChange(JSON.parse(value));
																	setJsonError("");
																} catch {
																	setJsonError(t("studio.invalidJson"));
																}
															}}
														/>
														<Show when={jsonError()}>
															<p role="alert">{jsonError()}</p>
														</Show>
													</TextField>
												}
											>
												<TextField
													class="studio-field"
													value={String(props.value ?? "")}
													disabled={props.disabled}
												>
													<TextField.Label>{label()}</TextField.Label>
													<Show
														when={schema().type === "number" || schema().type === "integer"}
														fallback={
															<TextField.TextArea
																rows={
																	/body|summary|description|interaction|assistant|user|prompt|note|quote/.test(
																		fieldName(),
																	)
																		? 4
																		: 1
																}
																onInput={(event) => props.onChange(event.currentTarget.value)}
															/>
														}
													>
														<TextField.Input
															type="number"
															min={schema().minimum}
															max={schema().maximum}
															step={schema().type === "integer" ? 1 : "any"}
															onInput={(event) => {
																if (event.currentTarget.value !== "")
																	props.onChange(Number(event.currentTarget.value));
															}}
														/>
													</Show>
												</TextField>
											</Show>
										}
									>
										<EditorSelect
											label={label()}
											value={String(props.value)}
											options={(schema().enum ?? [true, false]).map(String)}
											disabled={props.disabled}
											onChange={(value) =>
												props.onChange(
													(schema().enum ?? [true, false]).find(
														(option) => String(option) === value,
													),
												)
											}
										/>
									</Show>
								}
							>
								<h3>{label()}</h3>
								<Index each={values()}>
									{(value, index) => (
										<fieldset class="studio-collection-item">
											<legend>
												{props.path} [{index + 1}]
											</legend>
											<SchemaFields
												assets={props.assets}
												schema={schema().items ?? {}}
												value={value()}
												path={`${props.path}.${index}`}
												required
												disabled={props.disabled}
												onChange={(next) =>
													props.onChange(values().map((entry, i) => (i === index ? next : entry)))
												}
											/>
											<div class="studio-tools">
												<Button
													disabled={props.disabled || index === 0}
													onClick={() => reorder(index, -1)}
												>
													{t("studio.moveUp")}
												</Button>
												<Button
													disabled={props.disabled || index === values().length - 1}
													onClick={() => reorder(index, 1)}
												>
													{t("studio.moveDown")}
												</Button>
												<Button
													disabled={props.disabled}
													onClick={() => {
														if (window.confirm(t("studio.removeItem")))
															props.onChange(values().filter((_, i) => i !== index));
													}}
												>
													{t("studio.remove")}
												</Button>
											</div>
										</fieldset>
									)}
								</Index>
								<Button
									disabled={props.disabled || values().length >= (schema().maxItems ?? 1000)}
									onClick={() => props.onChange([...values(), defaultValue(schema().items ?? {})])}
								>
									{t("studio.addItem")}
								</Button>
							</Show>
						}
					>
						<h3>{label()}</h3>
						<For each={keys()}>
							{(key) => (
								<SchemaFields
									assets={props.assets}
									schema={
										schema().properties?.[key] ??
										(typeof schema().additionalProperties === "object"
											? (schema().additionalProperties as EditorSchema)
											: {})
									}
									value={object()[key]}
									path={`${props.path}.${key}`}
									required={schema().required?.includes(key)}
									disabled={props.disabled}
									onChange={(value) => update(key, value)}
								/>
							)}
						</For>
						<Show when={schema().additionalProperties !== false && !schema().properties}>
							<form
								class="studio-tools"
								onSubmit={(event) => {
									event.preventDefault();
									const key = newKey().trim();
									if (
										key &&
										!Object.hasOwn(object(), key) &&
										!["__proto__", "constructor", "prototype"].includes(key)
									) {
										update(
											key,
											defaultValue(
												typeof schema().additionalProperties === "object"
													? (schema().additionalProperties as EditorSchema)
													: {},
											),
										);
										setNewKey("");
									}
								}}
							>
								<TextField value={newKey()}>
									<TextField.Label>{t("studio.fieldKey")}</TextField.Label>
									<TextField.Input onInput={(event) => setNewKey(event.currentTarget.value)} />
								</TextField>
								<Button type="submit" disabled={props.disabled || !newKey().trim()}>
									{t("studio.addItem")}
								</Button>
							</form>
						</Show>
					</Show>
				</Show>
				<Show when={!props.required}>
					<Button
						disabled={props.disabled}
						onClick={() => {
							if (window.confirm(t("studio.removeItem"))) props.onChange(undefined);
						}}
					>
						{t("studio.removeField", { field: fieldName() })}
					</Button>
				</Show>
			</Show>
		</section>
	);
}
