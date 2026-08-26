import { i18n, useTranslation } from "@bear-harness/i18n";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { createMemo, createSignal, Show } from "solid-js";
import { markSelectPortalTopLayer } from "../lib/select-portal.js";
import { createStableSnapshot } from "../lib/stable-snapshot.js";
import type { ConfiguredModel } from "../stores/ipc.js";

export function modelRouteKey(model: Pick<ConfiguredModel, "providerId" | "modelId">): string {
	return `${model.providerId}\u0000${model.modelId}`;
}

export function configuredModelLabel(model: ConfiguredModel): string {
	return `${model.label} (${model.providerName ?? model.providerId})`;
}

type AutoModelOption = { kind: "auto" };
type ModelSelectOption = ConfiguredModel | AutoModelOption;

function isAutoModelOption(option: ModelSelectOption): option is AutoModelOption {
	return "kind" in option && option.kind === "auto";
}

/** Shared model picker. The model list is always Host-backed; search is presentation state only. */
export function ModelSelector(props: {
	models: readonly ConfiguredModel[];
	value: ConfiguredModel | null;
	class: string;
	label: string;
	labelClass?: string;
	disabled?: boolean;
	includeAuto?: boolean;
	autoLabel?: string;
	placeholder?: string;
	searchable?: boolean;
	placement?: "top-start" | "bottom-start";
	gutter?: number;
	triggerRef?: (element: HTMLButtonElement) => void;
	triggerClass?: string;
	contentClass?: string;
	listClass?: string;
	itemClass?: string;
	onModelChange: (model: ConfiguredModel | null) => void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const [query, setQuery] = createSignal("");
	const options = createStableSnapshot<ModelSelectOption[]>(() => [
		...(props.includeAuto ? [{ kind: "auto" as const }] : []),
		...props.models,
	]);
	const optionMatches = (option: ModelSelectOption): boolean => {
		const needle = query().trim().toLocaleLowerCase();
		if (!needle) return true;
		if (isAutoModelOption(option)) {
			return (props.autoLabel ?? "").toLocaleLowerCase().includes(needle);
		}
		return `${option.modelId} ${option.label} ${option.providerName ?? ""} ${option.providerId}`
			.toLocaleLowerCase()
			.includes(needle);
	};
	const selectedOption = createMemo<ModelSelectOption | null>(() => {
		const selected = props.value;
		return (
			options().find((option) =>
				isAutoModelOption(option)
					? props.includeAuto && !selected
					: selected && modelRouteKey(option) === modelRouteKey(selected),
			) ?? null
		);
	});
	const optionLabel = (option: ModelSelectOption): string =>
		isAutoModelOption(option) ? (props.autoLabel ?? "") : configuredModelLabel(option);

	return (
		<Select<ModelSelectOption>
			options={options()}
			value={selectedOption()}
			optionValue={(option) => (isAutoModelOption(option) ? "reply" : modelRouteKey(option))}
			optionTextValue={optionLabel}
			placeholder={props.placeholder ?? t("settings.chooseModel")}
			disabled={props.disabled}
			onChange={(option) =>
				props.onModelChange(option && !isAutoModelOption(option) ? option : null)
			}
			itemComponent={(itemProps) => (
				<Select.Item
					item={itemProps.item}
					class={props.itemClass ?? "select-item"}
					hidden={!optionMatches(itemProps.item.rawValue)}
				>
					<Select.ItemLabel>{optionLabel(itemProps.item.rawValue)}</Select.ItemLabel>
				</Select.Item>
			)}
			class={props.class}
			placement={props.placement}
			gutter={props.gutter}
		>
			<Select.Label class={props.labelClass ?? "field-label"}>{props.label}</Select.Label>
			<Select.Trigger
				ref={props.triggerRef}
				class={props.triggerClass ?? "select-trigger"}
				aria-label={props.label}
			>
				<Select.Value<ModelSelectOption> class="select-value">
					{(state) => {
						const option = state.selectedOption();
						return option ? optionLabel(option) : "";
					}}
				</Select.Value>
				<Select.Icon class="select-icon" aria-hidden="true">
					v
				</Select.Icon>
			</Select.Trigger>
			<Select.Portal ref={markSelectPortalTopLayer}>
				<Select.Content class={props.contentClass ?? "select-content"}>
					<Show when={props.searchable ?? true}>
						<TextField class="model-search-field">
							<TextField.Label class="sr-only">{t("settings.searchModels")}</TextField.Label>
							<TextField.Input
								class="model-search-input"
								value={query()}
								placeholder={t("settings.searchModels")}
								autocomplete="off"
								onInput={(event) => setQuery(event.currentTarget.value)}
								onKeyDown={(event) => {
									if (event.key !== "Escape") event.stopPropagation();
								}}
							/>
						</TextField>
					</Show>
					<Select.Listbox class={props.listClass ?? "select-listbox"} />
				</Select.Content>
			</Select.Portal>
		</Select>
	);
}
