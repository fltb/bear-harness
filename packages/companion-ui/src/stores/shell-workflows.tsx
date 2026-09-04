import { i18n, useLanguage } from "@bear-harness/i18n";
import type { Namespace, TFunction } from "i18next";
import {
	type Accessor,
	createContext,
	createMemo,
	createSignal,
	type JSX,
	type ParentProps,
	useContext,
} from "solid-js";
import type { CharacterDisplay, CompanionStore, SceneDisplay } from "./companion.js";
import { useCompanionStore } from "./companion.js";
import type { RunInfo, RunPermissionRequest } from "./ipc.js";

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

export interface SelectedArtifact {
	readonly run: RunInfo;
	readonly artifact: RunInfo["artifacts"][number];
}

export interface ShellWorkflowStore {
	readonly host: CompanionStore;
	readonly character: Accessor<CharacterDisplay | undefined>;
	readonly activeCharacterRuntime: Accessor<
		NonNullable<CompanionStore["companionState"]>["state"]["display"] | undefined
	>;
	readonly scene: Accessor<SceneDisplay | undefined>;
	readonly visualState: Accessor<string | undefined>;
	readonly composerPlaceholder: Accessor<string>;
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
	readonly runGroups: Accessor<Readonly<Record<string, RunInfo[]>>>;
	readonly selectedArtifact: Accessor<SelectedArtifact | undefined>;
	selectArtifact(runId: string, artifactId: string): void;
	closeArtifact(): void;
	permissionsForRun(runId: string): Accessor<RunPermissionRequest[]>;
	runsForMessage(messageId: string): Accessor<RunInfo[]>;
	permissionAction(id: string): WorkflowActionState;
	runActionState(id: string): RunWorkflowState;
	runPermissionAction(id: string, action: () => Promise<unknown>): void;
	runRunAction(id: string, action: () => Promise<unknown>): Promise<boolean>;
}

export const ShellWorkflowContext = createContext<ShellWorkflowStore | undefined>(undefined);
const shellWorkflows = new WeakMap<CompanionStore, ShellWorkflowStore>();
const MAX_ACTION_STATE_CACHE_ENTRIES = 32;

/**
 * Components normally receive the app-owned workflow through this context.
 * Renderer tests (and small embedded surfaces) intentionally mount only the
 * DesktopProvider, so lazily compose the same workflow from that store when
 * no explicit shell provider is present.
 */

export function ShellWorkflowProvider(props: ParentProps<{ workflow: ShellWorkflowStore }>) {
	return (
		<ShellWorkflowContext.Provider value={props.workflow}>
			{props.children}
		</ShellWorkflowContext.Provider>
	);
}

export function useShellWorkflowStore(): ShellWorkflowStore {
	const explicit = useContext(ShellWorkflowContext);
	if (explicit !== undefined) return explicit;
	const store = useCompanionStore();
	const existing = shellWorkflows.get(store);
	if (existing !== undefined) return existing;
	const [currentLocale] = useLanguage(() => i18n);
	const workflow = createShellWorkflowStore({
		store,
		currentLocale,
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
	const activeCharacterRuntime = createMemo(() => store.companionState?.state.display);
	const scene = createMemo(() => {
		const identity = character();
		const sceneId = activeCharacterRuntime()?.sceneId ?? identity?.visual.defaultSceneId;
		return identity?.scenes.find((candidate) => candidate.id === sceneId);
	});
	const visualState = createMemo(() => activeCharacterRuntime()?.expressionId);
	const composerPlaceholder = createMemo(
		() =>
			character()?.character.composer_placeholder ?? translate("shell.fallbackComposerPlaceholder"),
	);
	const languageWarningKey = createMemo(() => `${character()?.language ?? ""}|${currentLocale()}`);
	const hasLanguageMismatch = createMemo(() => {
		const roleLanguage = character()?.language;
		if (!roleLanguage) return false;
		return (
			roleLanguage.split("-")[0]?.toLowerCase() !== currentLocale().split("-")[0]?.toLowerCase()
		);
	});
	const languageWarning = createMemo(() =>
		translate("language.warningBody")
			.replace("{roleLanguage}", character()?.language ?? "")
			.replace("{userLanguage}", currentLocale()),
	);
	const themeStyle = createMemo((): JSX.CSSProperties => {
		const theme = character()?.theme;
		if (!theme) return {};
		return {
			"--sys-canvas": theme.tokens.canvas,
			"--sys-surface": theme.tokens.surface,
			"--sys-surface-raised": theme.tokens.surface_raised,
			"--sys-surface-interactive": theme.tokens.surface_interactive,
			"--sys-surface-selected": theme.tokens.surface_selected,
			"--sys-text": theme.tokens.text,
			"--sys-text-muted": theme.tokens.text_muted,
			"--sys-text-on-accent": theme.tokens.text_on_accent,
			"--sys-accent": theme.tokens.accent,
			"--sys-accent-hover": theme.tokens.accent_hover,
			"--sys-border": theme.tokens.border,
			"--sys-border-focus": theme.tokens.border_focus,
			"--sys-success": theme.tokens.success,
			"--sys-warning": theme.tokens.warning,
			"--sys-danger": theme.tokens.danger,
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
			(run) =>
				run.conversationId === store.activeConversationId &&
				(run.status === "enqueued" || run.status === "running" || run.status === "needs_user"),
		),
	);
	const runGroups = createMemo(() => {
		const groups: Record<string, RunInfo[]> = {};
		for (const run of store.runs ?? []) {
			const group = groups[run.triggerEntryId] ?? [];
			group.push(run);
			groups[run.triggerEntryId] = group;
		}
		return groups;
	});
	const [artifactSelection, setArtifactSelection] = createSignal<{
		runId: string;
		artifactId: string;
	}>();
	const selectedArtifact = createMemo<SelectedArtifact | undefined>(() => {
		const selection = artifactSelection();
		if (!selection) return undefined;
		const run = (store.runs ?? []).find(
			(candidate) =>
				candidate.id === selection.runId && candidate.conversationId === store.activeConversationId,
		);
		const artifact = run?.artifacts.find((candidate) => candidate.id === selection.artifactId);
		return run && artifact ? { run, artifact } : undefined;
	});
	const selectArtifact = (runId: string, artifactId: string) =>
		setArtifactSelection({ runId, artifactId });
	const closeArtifact = () => setArtifactSelection(undefined);
	const permissionGroups = createMemo(() => {
		const groups: Record<string, RunPermissionRequest[]> = {};
		for (const permission of store.run?.pendingPermissions?.() ?? []) {
			const group = groups[permission.runId] ?? [];
			group.push(permission);
			groups[permission.runId] = group;
		}
		return groups;
	});
	// Return direct reactive accessors. Caching nested memos here can leave an
	// initially-empty message or permission group detached from later query-cache
	// replacements, hiding a newly started run until the renderer is reloaded.
	const permissionsForRun =
		(runId: string): Accessor<RunPermissionRequest[]> =>
		() =>
			permissionGroups()[runId] ?? [];
	const runsForMessage =
		(messageId: string): Accessor<RunInfo[]> =>
		() =>
			(runGroups()[messageId] ?? []).filter(
				(run) => run.conversationId === store.activeConversationId,
			);
	const permissionStates = new Map<string, ReturnType<typeof actionState>>();
	const runStates = new Map<
		string,
		ReturnType<typeof actionState> & {
			steerText: Accessor<string>;
			setSteerText: (value: string) => void;
		}
	>();
	const getPermissionState = (id: string) => {
		let state = permissionStates.get(id);
		if (!state) {
			state = actionState();
			if (permissionStates.size >= MAX_ACTION_STATE_CACHE_ENTRIES) {
				const oldest = permissionStates.keys().next().value;
				if (oldest !== undefined) permissionStates.delete(oldest);
			}
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
			if (runStates.size >= MAX_ACTION_STATE_CACHE_ENTRIES) {
				const oldest = runStates.keys().next().value;
				if (oldest !== undefined) runStates.delete(oldest);
			}
			runStates.set(id, state);
		}
		return state;
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
		runGroups,
		selectedArtifact,
		selectArtifact,
		closeArtifact,
		permissionsForRun,
		runsForMessage,
		permissionAction: getPermissionState,
		runActionState: getRunState,
		runPermissionAction,
		runRunAction,
	};
}
