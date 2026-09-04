import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { IpcInvocationError } from "../src/lib/ipc.js";
import type { CompanionStore, SettingsData } from "../src/stores/companion.js";
import { invoke, isRecord, payloadString } from "../src/stores/ipc.js";
import {
	createFirstMeetingWorkflow,
	createNetworkMemoryWorkflow,
} from "../src/stores/setup-workflows.js";
import { createShellWorkflowStore } from "../src/stores/shell-workflows.js";
import { THEMED_CHARACTER } from "./fixtures.js";

const t = ((key: string) => key) as never;

describe("store IPC helpers", () => {
	it("accepts only non-null records and string payload fields", () => {
		expect(isRecord({ value: "ok" })).toBe(true);
		expect(isRecord([])).toBe(true);
		expect(isRecord(null)).toBe(false);
		expect(isRecord("value")).toBe(false);
		expect(payloadString({ value: "ok" }, "value")).toBe("ok");
		expect(payloadString({ value: 42 }, "value")).toBeUndefined();
		expect(payloadString(null, "value")).toBeUndefined();
	});

	it("unwraps success, converts RPC failures, and preserves transport failures", async () => {
		const client = {} as never;
		await expect(
			invoke(client, async () => ({ ok: true as const, data: { value: "safe" } })),
		).resolves.toEqual({ value: "safe" });
		await expect(
			invoke(client, async () => ({
				ok: false as const,
				error: { kind: "conflict", reason: "already_saved" },
			})),
		).rejects.toBeInstanceOf(IpcInvocationError);
		const transport = new Error("transport down");
		await expect(invoke(client, async () => Promise.reject(transport))).rejects.toBe(transport);
	});
});

describe("character language warning", () => {
	it("compares the character language with the app language, not navigator.language", () => {
		createRoot((dispose) => {
			const [locale, setLocale] = createSignal("ja-JP");
			const store = { character: THEMED_CHARACTER } as unknown as CompanionStore;
			const translate = ((key: string) =>
				key === "language.warningBody" ? "{roleLanguage}|{userLanguage}" : key) as never;
			const workflow = createShellWorkflowStore({
				store,
				currentLocale: locale,
				translate,
			});

			expect(workflow.hasLanguageMismatch()).toBe(false);
			setLocale("zh-CN");
			expect(workflow.hasLanguageMismatch()).toBe(true);
			expect(workflow.languageWarning()).toContain("zh-CN");
			dispose();
		});
	});
});

describe("shell action state retention", () => {
	it("evicts old Run and permission state instead of growing for the app lifetime", () => {
		createRoot((dispose) => {
			const store = {
				character: THEMED_CHARACTER,
				runs: [],
				run: { pendingPermissions: () => [] },
			} as unknown as CompanionStore;
			const workflow = createShellWorkflowStore({
				store,
				currentLocale: () => "zh-CN",
				translate: t,
			});
			const firstRun = workflow.runActionState("run-0");
			firstRun.setSteerText("retained only while cached");
			const firstPermission = workflow.permissionAction("permission-0");
			for (let index = 1; index <= 32; index += 1) {
				workflow.runActionState(`run-${index}`);
				workflow.permissionAction(`permission-${index}`);
			}

			expect(workflow.runActionState("run-0").steerText()).toBe("");
			expect(workflow.permissionAction("permission-0")).not.toBe(firstPermission);
			dispose();
		});
	});
});

describe("settings workflows", () => {
	it("stays safe when optional model projections are not installed yet", async () => {
		const store = {
			onboarding: { status: "inactive", currentStepId: null },
			loading: false,
			character: undefined,
			embedding: undefined,
			error: null,
			model: {},
		} as unknown as CompanionStore;

		await new Promise<void>((resolve, reject) => {
			createRoot((dispose) => {
				const firstMeeting = createFirstMeetingWorkflow(store);
				expect(firstMeeting.configuredModels()).toEqual([]);
				expect(firstMeeting.selectedReplyModel()).toBeNull();
				expect(firstMeeting.selectedVisionModel()).toBeNull();
				expect(firstMeeting.modelError()).toBeNull();
				expect(firstMeeting.currentStep()).toBeUndefined();
				expect(firstMeeting.currentStepIndex()).toBe(-1);
				expect(firstMeeting.currentStepLabel()).toBe("");
				expect(firstMeeting.visible()).toBe(false);

				dispose();
				resolve();
			});
		});
	});

	it("builds proxy patches, trims manual URLs, and remains retryable after failure", async () => {
		const [settings, setSettings] = createSignal<SettingsData>({
			networkProxy: { mode: "system" },
		} as SettingsData);
		const set = vi
			.fn()
			.mockRejectedValueOnce(new Error("cannot save"))
			.mockResolvedValueOnce(undefined);
		const store = { settings: { data: settings, set } } as unknown as CompanionStore;

		await new Promise<void>((resolve, reject) => {
			createRoot((dispose) => {
				const workflow = createNetworkMemoryWorkflow(store, t);
				expect(workflow.proxyMode()).toBe("system");
				expect(workflow.proxyUrl()).toBe("");
				workflow.setProxyMode("manual");
				workflow.setProxyUrl("  http://127.0.0.1:7890  ");
				void (async () => {
					await Promise.resolve();
					await workflow.save();
					expect(set).toHaveBeenLastCalledWith({
						networkProxy: { mode: "manual", url: "http://127.0.0.1:7890" },
					});
					expect(workflow.error()).toBe("cannot save");
					await workflow.save();
					expect(workflow.feedback()).toBe("settings.saved");
					workflow.setProxyUrl("   ");
					await workflow.save();
					expect(set).toHaveBeenLastCalledWith({ networkProxy: { mode: "manual" } });
					setSettings({ ...settings(), networkProxy: { mode: "off" } });
					dispose();
					resolve();
				})().catch(reject);
			});
		});
	});

	it("does nothing when proxy state is unavailable", async () => {
		const set = vi.fn();
		const store = { settings: { data: () => undefined, set } } as unknown as CompanionStore;
		await new Promise<void>((resolve) => {
			createRoot((dispose) => {
				const workflow = createNetworkMemoryWorkflow(store, t);
				expect(workflow.proxyMode()).toBeUndefined();
				void workflow.save().then(() => {
					expect(set).not.toHaveBeenCalled();
					dispose();
					resolve();
				});
			});
		});
	});
});
