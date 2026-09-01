import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { CurrentRolePackageManager } from "../src/features/CurrentRolePackageManager.js";
import type { CharacterDeletionStatus } from "../src/stores/ipc.js";
import { THEMED_CHARACTER } from "./fixtures.js";

const document = {
	characterId: "removable-role",
	origin: "local" as const,
	writable: true,
	yaml: `prompt:
  description: Test description
  personality: Test personality
  scenario: Test scenario
  system_prompt: Test system prompt
media: []
`,
	sha256: "a".repeat(64),
	character: { ...THEMED_CHARACTER, id: "removable-role", name: "Removable Role" },
};

function renderManager(
	initialStatus: CharacterDeletionStatus,
	operations: {
		deleteRuntime?: (id: string) => Promise<{ deleted: boolean }>;
		deletePackage?: (id: string) => Promise<{ deleted: boolean }>;
	} = {},
) {
	const [status, setStatus] = createSignal(initialStatus);
	const deleteRuntime = vi.fn(
		operations.deleteRuntime ??
			(async () => {
				setStatus((current) => ({ ...current, runtimePresent: false }));
				return { deleted: true };
			}),
	);
	const deletePackage = vi.fn(
		operations.deletePackage ??
			(async () => {
				setStatus((current) => ({ ...current, packagePresent: false }));
				return { deleted: true };
			}),
	);
	render(() => (
		<CurrentRolePackageManager
			characters={() => [
				{ id: document.characterId, name: document.character.name, active: initialStatus.active },
			]}
			selectedId={() => document.characterId}
			document={() => document}
			loading={() => false}
			error={() => undefined}
			selectPackage={() => undefined}
			savePackage={() => Promise.resolve(document)}
			pluginTrust={() =>
				Promise.resolve({ origin: "local", pluginHash: "", pluginsPresent: false, trusted: true })
			}
			pluginTrustData={() => ({
				origin: "local",
				pluginHash: "",
				pluginsPresent: false,
				trusted: true,
			})}
			confirmPluginTrust={() => Promise.resolve()}
			deletionStatus={status}
			deletionStatusLoading={() => false}
			deletionStatusError={() => undefined}
			deleteRuntime={deleteRuntime}
			deletePackage={deletePackage}
		/>
	));
	return { deletePackage, deleteRuntime };
}

describe("character physical deletion UI", () => {
	it("keeps default-package protection separate from runtime deletion", () => {
		renderManager({
			characterId: document.characterId,
			active: false,
			default: true,
			runtimePresent: true,
			packagePresent: true,
		});

		expect(
			screen.getByRole("button", { name: zhCN.currentRolePackage.deleteRuntime }),
		).toBeEnabled();
		expect(
			screen.getByRole("button", { name: zhCN.currentRolePackage.deletePackage }),
		).toBeDisabled();
		expect(screen.getByText(zhCN.currentRolePackage.deleteBlockedDefault)).toBeVisible();
	});

	it("requires runtime deletion before package deletion and confirms both consequences", async () => {
		const user = userEvent.setup();
		const { deletePackage, deleteRuntime } = renderManager({
			characterId: document.characterId,
			active: false,
			default: false,
			runtimePresent: true,
			packagePresent: true,
		});
		const runtimeButton = screen.getByRole("button", {
			name: zhCN.currentRolePackage.deleteRuntime,
		});
		const packageButton = screen.getByRole("button", {
			name: zhCN.currentRolePackage.deletePackage,
		});
		expect(runtimeButton).toBeEnabled();
		expect(packageButton).toBeDisabled();
		expect(screen.getByText(zhCN.currentRolePackage.deleteBlockedRuntimePresent)).toBeVisible();

		await user.click(runtimeButton);
		const runtimeDialog = screen.getByRole("dialog", {
			name: zhCN.currentRolePackage.deleteRuntimeConfirmTitle,
		});
		expect(within(runtimeDialog).getByText(/对话、状态、记忆、外部任务、产物/)).toBeVisible();
		await user.click(
			within(runtimeDialog).getByRole("button", {
				name: zhCN.currentRolePackage.deleteConfirmAction,
			}),
		);
		expect(deleteRuntime).toHaveBeenCalledWith(document.characterId);
		await waitFor(() => expect(packageButton).toBeEnabled());

		await user.click(packageButton);
		const packageDialog = screen.getByRole("dialog", {
			name: zhCN.currentRolePackage.deletePackageConfirmTitle,
		});
		expect(within(packageDialog).getByText(/角色定义、素材、世界设定、插件与技能/)).toBeVisible();
		await user.click(
			within(packageDialog).getByRole("button", {
				name: zhCN.currentRolePackage.deleteConfirmAction,
			}),
		);
		expect(deletePackage).toHaveBeenCalledWith(document.characterId);
	});

	it("disables both destructive actions for the active character", () => {
		renderManager({
			characterId: document.characterId,
			active: true,
			default: false,
			runtimePresent: true,
			packagePresent: true,
		});

		expect(
			screen.getByRole("button", { name: zhCN.currentRolePackage.deleteRuntime }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: zhCN.currentRolePackage.deletePackage }),
		).toBeDisabled();
		expect(screen.getAllByText(zhCN.currentRolePackage.deleteBlockedActive)).toHaveLength(2);
	});
});
