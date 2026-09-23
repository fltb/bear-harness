import { i18n, useTranslation } from "@bear-harness/i18n";
import type {
	RunnerEnvironment,
	RunnerProfile,
	RunnerSaveRequest,
	RunnerTestResponse,
} from "@bear-harness/protocol";
import { CacheKey } from "@bear-harness/protocol/schema";
import { createQuery } from "@tanstack/solid-query";
import { createSignal, For, Index, Show } from "solid-js";
import { useCompanionStore } from "../stores/companion.js";
import { Button, Checkbox, TextField } from "../ui/primitives.js";

export function RunnerSettings() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const profiles = createQuery(() => ({
		queryKey: [...CacheKey.settings(), "runners"],
		queryFn: () => store.externalAgent.list(),
	}));
	const [editing, setEditing] = createSignal<{ profile?: RunnerProfile }>();
	const [testing, setTesting] = createSignal<string>();
	const [error, setError] = createSignal<string>();
	const [result, setResult] = createSignal<{ id: string; value: RunnerTestResponse }>();
	const test = async (runnerId: string) => {
		setTesting(runnerId);
		setError();
		setResult();
		try {
			setResult({ id: runnerId, value: await store.externalAgent.test(runnerId) });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setTesting();
		}
	};
	return (
		<section class="settings-section settings-page-section">
			<header class="settings-section-header">
				<h4>{t("settings.runnerProfiles")}</h4>
				<p class="field-hint">{t("settings.runnerDefaultHint")}</p>
			</header>
			<Show when={profiles.error || error()}>
				<p class="status-line err" role="alert">
					{error() ?? String(profiles.error)}
				</p>
			</Show>
			<For each={profiles.data ?? []}>
				{(profile) => (
					<section class="provider-card" aria-label={profile.name}>
						<strong>{profile.name}</strong>
						<p class="field-hint">{profile.description}</p>
						<p class="field-hint">{profile.useWhen}</p>
						<Show when={profile.limitations}>
							<p class="field-hint">{profile.limitations}</p>
						</Show>
						<p class="field-hint">
							{profile.enabled ? t("settings.runnerEnabled") : t("settings.runnerDisabled")}
						</p>
						<Button type="button" onClick={() => setEditing({ profile })}>
							{t("settings.runnerEdit")}
						</Button>
						<Button
							type="button"
							disabled={Boolean(testing()) || !profile.enabled}
							onClick={() => void test(profile.runnerId)}
						>
							{testing() === profile.runnerId ? t("settings.loading") : t("settings.runnerTest")}
						</Button>
						<Show when={result()?.id === profile.runnerId ? result()?.value : undefined}>
							{(value) => (
								<div role="status" class="field-hint">
									<p>
										{t("settings.runnerTestOk", { name: value().name, version: value().version })}
									</p>
									<p>
										{t("settings.runnerRecovery")}:{" "}
										{value().capabilities.loadSession || value().capabilities.resume
											? t("settings.runnerSupported")
											: t("settings.runnerUnsupported")}
									</p>
									<p>
										{t("settings.runnerSteering")}:{" "}
										{value().capabilities.steer
											? t("settings.runnerSupported")
											: t("settings.runnerUnsupported")}
									</p>
								</div>
							)}
						</Show>
					</section>
				)}
			</For>
			<Button type="button" onClick={() => setEditing({})}>
				{t("settings.runnerAdd")}
			</Button>
			<Show when={editing()} keyed>
				{(value) => (
					<RunnerEditor
						profile={value.profile}
						save={async (input) => {
							await store.externalAgent.save(input);
							setEditing();
							await profiles.refetch();
						}}
						cancel={() => setEditing()}
					/>
				)}
			</Show>
		</section>
	);
}
function RunnerEditor(props: {
	profile?: RunnerProfile;
	save(input: RunnerSaveRequest): Promise<void>;
	cancel(): void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const [name, setName] = createSignal(props.profile?.name ?? "");
	const [description, setDescription] = createSignal(props.profile?.description ?? "");
	const [useWhen, setUseWhen] = createSignal(props.profile?.useWhen ?? "");
	const [limitations, setLimitations] = createSignal(props.profile?.limitations ?? "");
	const [enabled, setEnabled] = createSignal(props.profile?.enabled ?? true);
	const [command, setCommand] = createSignal(props.profile?.configuration?.command ?? "");
	const [args, setArgs] = createSignal(props.profile?.configuration?.args.join("\n") ?? "");
	const [dependencies, setDependencies] = createSignal(
		props.profile?.configuration?.dependencyPaths.join("\n") ?? "",
	);
	const [auth, setAuth] = createSignal(props.profile?.configuration?.authMethodId ?? "");
	const [environment, setEnvironment] = createSignal<RunnerEnvironment[]>(
		props.profile?.configuration?.environment ?? [],
	);
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string>();
	const custom = () => !props.profile || props.profile.kind === "custom";
	const save = async (event: SubmitEvent) => {
		event.preventDefault();
		setBusy(true);
		setError();
		try {
			await props.save({
				runnerId: props.profile?.runnerId,
				name: name().trim(),
				description: description().trim(),
				useWhen: useWhen().trim(),
				limitations: limitations().trim(),
				enabled: enabled(),
				...(custom()
					? {
							configuration: {
								command: command().trim(),
								args: args() ? args().split("\n") : [],
								dependencyPaths: dependencies()
									.split("\n")
									.map((value) => value.trim())
									.filter(Boolean),
								environment: environment(),
								...(auth().trim() ? { authMethodId: auth().trim() } : {}),
							},
						}
					: {}),
			});
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};
	const field = (
		label: string,
		value: () => string,
		change: (value: string) => void,
		multiline = false,
	) => (
		<TextField class="setting-field" value={value()} onChange={change} disabled={busy()}>
			<TextField.Label>{label}</TextField.Label>
			{multiline ? <TextField.TextArea /> : <TextField.Input />}
		</TextField>
	);
	return (
		<form class="settings-fields" onSubmit={(event) => void save(event)}>
			{field(t("settings.runnerName"), name, setName)}
			{field(t("settings.runnerDescription"), description, setDescription, true)}
			{field(t("settings.runnerUseWhen"), useWhen, setUseWhen, true)}
			{field(t("settings.runnerLimitations"), limitations, setLimitations, true)}
			<Checkbox
				class="setting-field"
				checked={enabled()}
				onChange={setEnabled}
				disabled={busy() || props.profile?.runnerId === "pi-default"}
			>
				<Checkbox.Input />
				<Checkbox.Control />
				<Checkbox.Label>{t("settings.runnerEnabled")}</Checkbox.Label>
			</Checkbox>
			<Show when={custom()}>
				{field(t("settings.runnerCommand"), command, setCommand)}
				{field(t("settings.runnerArgs"), args, setArgs, true)}
				{field(t("settings.runnerDependencies"), dependencies, setDependencies, true)}
				{field(t("settings.runnerAuth"), auth, setAuth)}
				<p class="field-hint">{t("settings.runnerEnvironmentHint")}</p>
				<Index each={environment()}>
					{(item, index) => (
						<EnvironmentField
							item={item()}
							disabled={busy()}
							onChange={(value) =>
								setEnvironment((rows) => rows.map((row, i) => (i === index ? value : row)))
							}
							remove={() => setEnvironment((rows) => rows.filter((_, i) => i !== index))}
						/>
					)}
				</Index>
				<Button
					type="button"
					disabled={busy()}
					onClick={() =>
						setEnvironment((rows) => [...rows, { name: "", value: "", secret: false }])
					}
				>
					{t("settings.runnerAddEnvironment")}
				</Button>
			</Show>
			<Show when={error()}>
				<p class="status-line err" role="alert">
					{error()}
				</p>
			</Show>
			<Button type="submit" disabled={busy() || !name().trim() || (custom() && !command().trim())}>
				{t("settings.runnerSave")}
			</Button>
			<Button type="button" disabled={busy()} onClick={props.cancel}>
				{t("settings.runnerCancel")}
			</Button>
		</form>
	);
}
function EnvironmentField(props: {
	item: RunnerEnvironment;
	disabled: boolean;
	onChange(value: RunnerEnvironment): void;
	remove(): void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	return (
		<div class="settings-fields">
			<TextField
				class="setting-field"
				value={props.item.name}
				onChange={(name) => props.onChange({ ...props.item, name })}
				disabled={props.disabled}
			>
				<TextField.Label>{t("settings.runnerEnvironmentName")}</TextField.Label>
				<TextField.Input />
			</TextField>
			<TextField
				class="setting-field"
				value={props.item.value ?? ""}
				onChange={(value) => props.onChange({ ...props.item, value })}
				disabled={props.disabled}
			>
				<TextField.Label>{t("settings.runnerEnvironmentValue")}</TextField.Label>
				<TextField.Input type={props.item.secret ? "password" : "text"} autocomplete="off" />
			</TextField>
			<Checkbox
				class="setting-field"
				checked={props.item.secret}
				onChange={(secret) => props.onChange({ ...props.item, secret })}
				disabled={props.disabled}
			>
				<Checkbox.Input />
				<Checkbox.Control />
				<Checkbox.Label>{t("settings.runnerSecret")}</Checkbox.Label>
			</Checkbox>
			<Button type="button" disabled={props.disabled} onClick={props.remove}>
				{t("settings.runnerRemoveEnvironment")}
			</Button>
		</div>
	);
}
