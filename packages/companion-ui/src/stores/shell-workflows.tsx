import { i18n } from "@bear-harness/i18n";
import { createContext, createMemo, createSignal, type Accessor, type JSX, type ParentProps, useContext } from "solid-js";
import type { Namespace, TFunction } from "i18next";
import type {
	CharacterDisplay,
	CharacterRuntimeState,
	CompanionStore,
	SceneDisplay,
} from "./companion.js";
import { useCompanionStore } from "./companion.js";
import type { Artifact, Commission, RunInfo, RunPermissionRequest } from "./ipc.js";

export type BackstageTab = "roles" | "settings";

type Translate = TFunction<Namespace, undefined>;

export interface WorkflowActionState {
	busy: Accessor<boolean>;
	error: Accessor<string | null>;
}

export interface RunWorkflowState extends WorkflowActionState {
	steerText: Accessor<string>;
	setSteerText(value: string): void;
}

export interface ShellWorkflowStore {
	readonly host: CompanionStore;
	readonly character: Accessor<CharacterDisplay | undefined>;
	readonly activeCharacterRuntime: Accessor<CharacterRuntimeState | undefined>;
	readonly scene: Accessor<SceneDisplay | undefined>;
	readonly visualState: Accessor<string | undefined>;
	readonly composerPlaceholder: Accessor<string>;
	readonly preferredLanguage: Accessor<string>;
	readonly languageWarningKey: Accessor<string>;
	readonly hasLanguageMismatch: Accessor<boolean>;
	readonly languageWarning: Accessor<string>;
	readonly themeStyle: Accessor<JSX.CSSProperties>;
	readonly showLanguageWarning: Accessor<boolean>;
	dismissLanguageWarning(): void;
	readonly backstageOpen: Accessor<boolean>;
	readonly backstageTab: Accessor<BackstageTab>;
	openBackstage(tab?: BackstageTab): void;
	closeBackstage(): void;
	readonly queueOpen: Accessor<boolean>;
	toggleQueue(): void;
	closeQueue(): void;
	readonly activeRuns: Accessor<RunInfo[]>;
	readonly artifactGroups: Accessor<Readonly<Record<string, Artifact[]>>>;
	readonly commissionGroups: Accessor<Readonly<Record<string, Commission[]>>>;
	readonly runGroups: Accessor<Readonly<Record<string, RunInfo[]>>>;
	artifactsForRun(runId: string): Accessor<Artifact[]>;
	permissionsForRun(runId: string): Accessor<RunPermissionRequest[]>;
	commissionsForMessage(messageId: string): Accessor<Commission[]>;
	runsForCommission(commissionId: string): Accessor<RunInfo[]>;
	commissionAction(id: string): WorkflowActionState;
	permissionAction(id: string): WorkflowActionState;
	runActionState(id: string): RunWorkflowState;
	runCommissionAction(id: string, action: () => Promise<unknown>): Promise<void>;
	runPermissionAction(id: string, action: () => Promise<unknown>): void;
	runRunAction(id: string, action: () => Promise<unknown>): Promise<boolean>;
}

export const ShellWorkflowContext = createContext<ShellWorkflowStore | undefined>(undefined);
const shellWorkflows = new WeakMap<CompanionStore, ShellWorkflowStore>();

/**
 * Components normally receive the app-owned workflow through this context.
 * Renderer tests (and small embedded surfaces) intentionally mount only the
 * DesktopProvider, so lazily compose the same workflow from that store when
 * no explicit shell provider is present.
 */

export function ShellWorkflowProvider(props: ParentProps<{ workflow: ShellWorkflowStore }>) {
	return <ShellWorkflowContext.Provider value={props.workflow}>{props.children}</ShellWorkflowContext.Provider>;
}

export function useShellWorkflowStore(): ShellWorkflowStore {
	const explicit = useContext(ShellWorkflowContext);
	if (explicit !== undefined) return explicit;
	const store = useCompanionStore();
	const existing = shellWorkflows.get(store);
	if (existing !== undefined) return existing;
	const workflow = createShellWorkflowStore({
		store,
		currentLocale: () => i18n.language,
		translate: ((key: string) => i18n.t(key as never)) as Translate,
	});
	shellWorkflows.set(store, workflow);
	return workflow;
}

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

function actionState() {
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	return { busy, setBusy, error, setError };
}

export function createShellWorkflowStore(input: {
	store: CompanionStore;
	currentLocale: Accessor<string>;
	translate: Translate;
}): ShellWorkflowStore {
	const { store, currentLocale, translate } = input;
	const character = createMemo(() => store.character);
	const activeCharacterRuntime = createMemo(() => {
		const conversationId = store.activeConversationId;
		return conversationId ? store.characterRuntimeByConversation?.[conversationId] : undefined;
	});
	const scene = createMemo(() => {
		const identity = character();
		const sceneId = activeCharacterRuntime()?.sceneId ?? identity?.visual.defaultSceneId;
		return identity?.scenes.find((candidate) => candidate.id === sceneId);
	});
	const visualState = createMemo(() => activeCharacterRuntime()?.visualState);
	const composerPlaceholder = createMemo(
		() => character()?.character.composer_placeholder ?? translate("shell.fallbackComposerPlaceholder"),
	);
	const preferredLanguage = createMemo(
		() => globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language ?? currentLocale(),
	);
	const languageWarningKey = createMemo(() => `${character()?.language ?? ""}|${preferredLanguage()}`);
	const hasLanguageMismatch = createMemo(() => {
		const roleLanguage = character()?.language;
		if (!roleLanguage) return false;
		return roleLanguage.split("-")[0]?.toLowerCase() !== preferredLanguage().split("-")[0]?.toLowerCase();
	});
	const languageWarning = createMemo(() =>
		translate("language.warningBody")
			.replace("{roleLanguage}", character()?.language ?? "")
			.replace("{userLanguage}", preferredLanguage()),
	);
	const themeStyle = createMemo((): JSX.CSSProperties => {
		const theme = character()?.theme;
		if (!theme) return {};
		return {
			"--surface": theme.color.surface,
			"--surface-alt": theme.color.surface_alt,
			"--text": theme.color.text,
			"--text-muted": theme.color.text_muted,
			"--accent": theme.color.accent,
			"--line": theme.color.line,
			"--danger": theme.color.danger,
			"--amber": theme.color.amber,
			"--radius-sm": `${theme.radius.sm}px`,
			"--radius-md": `${theme.radius.md}px`,
			"--radius-lg": `${theme.radius.lg}px`,
			"--font-body": theme.font.body,
			"--font-heading": theme.font.heading,
		} as JSX.CSSProperties;
	});
	const [dismissedLanguageWarning, setDismissedLanguageWarning] = createSignal("");
	const showLanguageWarning = createMemo(
		() => hasLanguageMismatch() && dismissedLanguageWarning() !== languageWarningKey(),
	);
	const dismissLanguageWarning = () => setDismissedLanguageWarning(languageWarningKey());

	const [backstageOpen, setBackstageOpen] = createSignal(false);
	const [backstageTab, setBackstageTab] = createSignal<BackstageTab>("roles");
	const openBackstage = (tab: BackstageTab = "roles") => {
		setBackstageTab(tab);
		setBackstageOpen(true);
	};
	const closeBackstage = () => setBackstageOpen(false);
	const [queueOpen, setQueueOpen] = createSignal(false);
	const toggleQueue = () => setQueueOpen((open) => !open);
	const closeQueue = () => setQueueOpen(false);

	const activeRuns = createMemo(() =>
		(store.runs ?? []).filter(
			(run) => run.status === "enqueued" || run.status === "running" || run.status === "needs_user",
		),
	);
	const artifactGroups = createMemo(() => {
		const groups: Record<string, Artifact[]> = {};
		for (const artifact of store.artifact?.artifacts?.() ?? []) {
			if (artifact.producerRunId) (groups[artifact.producerRunId] ??= []).push(artifact);
		}
		return groups;
	});
	const commissionGroups = createMemo(() => {
		const groups: Record<string, Commission[]> = {};
		for (const commission of store.commission?.commissions?.() ?? []) {
			if (commission.triggerMessageId) (groups[commission.triggerMessageId] ??= []).push(commission);
		}
		return groups;
	});
	const runGroups = createMemo(() => {
		const groups: Record<string, RunInfo[]> = {};
		for (const run of store.runs ?? []) (groups[run.commissionId] ??= []).push(run);
		return groups;
	});
	const permissionGroups = createMemo(() => {
		const groups: Record<string, RunPermissionRequest[]> = {};
		for (const permission of store.run?.pendingPermissions?.() ?? []) (groups[permission.runId] ??= []).push(permission);
		return groups;
	});
	const artifactSelectors = new Map<string, Accessor<Artifact[]>>();
	const permissionSelectors = new Map<string, Accessor<RunPermissionRequest[]>>();
	const commissionSelectors = new Map<string, Accessor<Commission[]>>();
	const runSelectors = new Map<string, Accessor<RunInfo[]>>();
	const artifactsForRun = (runId: string) => {
		let artifactsForRun = artifactSelectors.get(runId);
		if (!artifactsForRun) {
			artifactsForRun = createMemo(() => artifactGroups()[runId] ?? []);
			artifactSelectors.set(runId, artifactsForRun);
		}
		return artifactsForRun;
	};
	const permissionsForRun = (runId: string) => {
		let permissionsForRun = permissionSelectors.get(runId);
		if (!permissionsForRun) {
			permissionsForRun = createMemo(() => permissionGroups()[runId] ?? []);
			permissionSelectors.set(runId, permissionsForRun);
		}
		return permissionsForRun;
	};
	const commissionsForMessage = (messageId: string) => {
		let commissionsForMessage = commissionSelectors.get(messageId);
		if (!commissionsForMessage) {
			commissionsForMessage = createMemo(() =>
				(commissionGroups()[messageId] ?? []).filter(
					(item) => !item.conversationId || item.conversationId === store.activeConversationId,
				),
			);
			commissionSelectors.set(messageId, commissionsForMessage);
		}
		return commissionsForMessage;
	};
	const runsForCommission = (commissionId: string) => {
		let runsForCommission = runSelectors.get(commissionId);
		if (!runsForCommission) {
			runsForCommission = createMemo(() => runGroups()[commissionId] ?? []);
			runSelectors.set(commissionId, runsForCommission);
		}
		return runsForCommission;
	};

	const commissionStates = new Map<string, ReturnType<typeof actionState>>();
	const permissionStates = new Map<string, ReturnType<typeof actionState>>();
	const runStates = new Map<string, ReturnType<typeof actionState> & { steerText: Accessor<string>; setSteerText: (value: string) => void }>();
	const getCommissionState = (id: string) => {
		let state = commissionStates.get(id);
		if (!state) {
			state = actionState();
			commissionStates.set(id, state);
		}
		return state;
	};
	const getPermissionState = (id: string) => {
		let state = permissionStates.get(id);
		if (!state) {
			state = actionState();
			permissionStates.set(id, state);
		}
		return state;
	};
	const getRunState = (id: string) => {
		let state = runStates.get(id);
		if (!state) {
			const base = actionState();
			const [steerText, setSteerText] = createSignal("");
			state = { ...base, steerText, setSteerText };
			runStates.set(id, state);
		}
		return state;
	};
	const runCommissionAction = async (id: string, action: () => Promise<unknown>) => {
		const state = getCommissionState(id);
		state.setBusy(true);
		state.setError(null);
		const before = store.errorMetadata;
		try {
			await action();
			const retained = store.errorMetadata;
			if (retained !== null && retained !== before) state.setError(retained.message);
		} catch (cause) {
			state.setError(messageOf(cause));
		} finally {
			state.setBusy(false);
		}
	};
	const runPermissionAction = (id: string, action: () => Promise<unknown>) => {
		const state = getPermissionState(id);
		state.setBusy(true);
		state.setError(null);
		const before = store.errorMetadata;
		void Promise.resolve()
			.then(action)
			.then(() => {
				const retained = store.errorMetadata;
				if (retained !== null && retained !== before) state.setError(retained.message);
			})
			.catch((cause) => state.setError(messageOf(cause)))
			.finally(() => state.setBusy(false));
	};
	const runRunAction = async (id: string, action: () => Promise<unknown>): Promise<boolean> => {
		const state = getRunState(id);
		state.setBusy(true);
		state.setError(null);
		const before = store.errorMetadata;
		try {
			await action();
			const retained = store.errorMetadata;
			if (retained !== null && retained !== before) {
				state.setError(retained.message);
				return false;
			}
			return true;
		} catch (cause) {
			state.setError(messageOf(cause));
			return false;
		} finally {
			state.setBusy(false);
		}
	};

	return {
		host: store,
		character,
		activeCharacterRuntime,
		scene,
		visualState,
		composerPlaceholder,
		preferredLanguage,
		languageWarningKey,
		hasLanguageMismatch,
		languageWarning,
		themeStyle,
		showLanguageWarning,
		dismissLanguageWarning,
		backstageOpen,
		backstageTab,
		openBackstage,
		closeBackstage,
		queueOpen,
		toggleQueue,
		closeQueue,
		activeRuns,
		artifactGroups,
		commissionGroups,
		runGroups,
		artifactsForRun,
		permissionsForRun,
		commissionsForMessage,
		runsForCommission,
		commissionAction: getCommissionState,
		permissionAction: getPermissionState,
		runActionState: getRunState,
		runCommissionAction,
		runPermissionAction,
		runRunAction,
	};
}
