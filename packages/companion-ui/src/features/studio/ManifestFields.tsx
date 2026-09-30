import { i18n, useTranslation } from "@bear-harness/i18n";
import { createMemo, For, Show } from "solid-js";
import { isMap, isSeq, parseDocument } from "yaml";
import { TextField } from "../../ui/primitives.js";

const fields = [
	{ path: ["name"], label: "name", required: true },
	{ path: ["version"], label: "version", required: true },
	{ path: ["language"], label: "language", required: true },
	{ path: ["character", "subtitle"], label: "subtitle" },
	{ path: ["character", "greeting"], label: "greeting", multiline: true },
	{ path: ["behavior", "identity", "summary"], label: "identity", required: true, multiline: true },
	{
		path: ["behavior", "identity", "invariants"],
		label: "invariants",
		multiline: true,
		list: true,
	},
	{
		path: ["behavior", "identity", "knowledge_boundaries"],
		label: "knowledge",
		multiline: true,
		list: true,
	},
	{ path: ["behavior", "interaction"], label: "interaction", multiline: true },
	{ path: ["system_prompt"], label: "systemPrompt", multiline: true },
] as const;

export function ManifestFields(props: {
	source: string;
	onChange(value: string): void;
	disabled?: boolean;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const document = createMemo(() => parseDocument(props.source));
	const editable = createMemo(() => {
		const doc = document();
		if (doc.errors.length || !isMap(doc.contents)) return false;
		return fields.every((field) => {
			for (let length = 1; length < field.path.length; length++) {
				const parent = doc.getIn(field.path.slice(0, length));
				if (parent !== undefined && !isMap(parent)) return false;
			}
			const value = doc.getIn(field.path);
			return (
				value === undefined ||
				("list" in field
					? isSeq(value) && value.toJSON().every((item: unknown) => typeof item === "string")
					: typeof value === "string")
			);
		});
	});
	const read = (path: readonly string[]) => {
		const value = document().getIn(path);
		return typeof value === "string"
			? value
			: Array.isArray((value as { toJSON?: () => unknown })?.toJSON?.())
				? (value as { toJSON: () => string[] }).toJSON().join("\n")
				: "";
	};
	function change(field: (typeof fields)[number], value: string) {
		const next = parseDocument(props.source);
		if (!editable()) return;
		if (!("required" in field) && !value.trim()) next.deleteIn(field.path);
		else
			next.setIn(
				field.path,
				"list" in field
					? value
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean)
					: value,
			);
		props.onChange(String(next));
	}
	return (
		<div class="studio-fields">
			<Show when={editable()} fallback={<p role="alert">{t("studio.invalidYaml")}</p>}>
				<For each={fields}>
					{(field) => (
						<TextField class="studio-field" value={read(field.path)} disabled={props.disabled}>
							<TextField.Label>
								{t(`studio.${field.label}`)}{" "}
								{"required" in field ? t("studio.required") : t("studio.optional")}
							</TextField.Label>
							<TextField.Description class="field-hint">
								{field.path.join(".")}
								{"list" in field ? ` · ${t("studio.onePerLine")}` : ""}
							</TextField.Description>
							<Show
								when={"multiline" in field}
								fallback={
									<TextField.Input onInput={(event) => change(field, event.currentTarget.value)} />
								}
							>
								<TextField.TextArea
									rows={field.path[0] === "system_prompt" ? 8 : 4}
									onInput={(event) => change(field, event.currentTarget.value)}
								/>
							</Show>
						</TextField>
					)}
				</For>
			</Show>
		</div>
	);
}
