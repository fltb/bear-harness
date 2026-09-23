import { zhCN } from "@bear-harness/i18n/locales";
import type { MemoryInspectRequest, MemoryInspectResponse } from "@bear-harness/protocol";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { RelationshipMemory } from "../src/features/RelationshipMemory.js";

function response(characterId: string, text: string): MemoryInspectResponse {
	return {
		characterId,
		relationshipMemoryEnabled: false,
		items: [
			{
				id: "same-id",
				type: "persona",
				content: text,
				sceneName: "日常",
				createdAt: "2026-09-13T00:00:00Z",
				updatedAt: "2026-09-13T00:00:00Z",
			},
		],
	};
}

function mount(
	load: (request: MemoryInspectRequest) => Promise<MemoryInspectResponse>,
	options: {
		systemEnabled?: boolean;
		memoryGet?: (characterId: string) => Promise<{ enabled: boolean }>;
		memorySet?: (characterId: string, enabled: boolean) => Promise<{ enabled: boolean }>;
	} = {},
) {
	const [characterId, setCharacterId] = createSignal("first");
	const onSystemSettings = vi.fn();
	const memoryGet = vi.fn(options.memoryGet ?? (async () => ({ enabled: false })));
	const memorySet = vi.fn(options.memorySet ?? (async (_id, enabled) => ({ enabled })));
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(() => (
		<QueryClientProvider client={client}>
			<RelationshipMemory
				characterId={characterId}
				characterName={characterId}
				load={load}
				memoryGet={memoryGet}
				memorySet={memorySet}
				systemMemoryEnabled={() => options.systemEnabled ?? true}
				onSystemSettings={onSystemSettings}
			/>
		</QueryClientProvider>
	));
	return { ...view, setCharacterId, onSystemSettings, memoryGet, memorySet };
}

describe("relationship memory viewer", () => {
	it("starts with consent off and persists the user's choice only for the selected character", async () => {
		const saved = new Map<string, boolean>();
		const view = mount(async (request) => response(request.characterId, "stored"), {
			memoryGet: async (id) => ({ enabled: saved.get(id) ?? false }),
			memorySet: async (id, enabled) => {
				saved.set(id, enabled);
				return { enabled };
			},
		});
		const checkbox = await screen.findByRole("checkbox");
		await waitFor(() => expect(checkbox).toBeEnabled());
		expect(checkbox).not.toBeChecked();
		fireEvent.click(checkbox);
		await waitFor(() => expect(checkbox).toBeChecked());
		expect(view.memorySet).toHaveBeenCalledWith("first", true);
		view.setCharacterId("second");
		await waitFor(() => expect(view.memoryGet).toHaveBeenCalledWith("second"));
		await waitFor(() => expect(screen.getByRole("checkbox")).toBeEnabled());
		expect(screen.getByRole("checkbox")).not.toBeChecked();
		view.setCharacterId("first");
		await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
		expect(view.memorySet).toHaveBeenCalledTimes(1);
	});

	it("links missing system prerequisites without repeating setup or granting consent", async () => {
		const view = mount(async (request) => response(request.characterId, "stored"), {
			systemEnabled: false,
		});
		await waitFor(() => expect(view.memoryGet).toHaveBeenCalledWith("first"));
		expect(screen.getByRole("checkbox")).toBeDisabled();
		expect(screen.getByText(zhCN.relationshipMemory.systemRequired)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: zhCN.relationshipMemory.systemSettings }));
		expect(view.onSystemSettings).toHaveBeenCalledOnce();
		expect(view.memorySet).not.toHaveBeenCalled();
	});

	it("allows revoking consent even when system memory is disabled and preserves readable memory", async () => {
		const view = mount(async (request) => response(request.characterId, "已有的角色记忆"), {
			systemEnabled: false,
			memoryGet: async () => ({ enabled: true }),
		});
		await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
		fireEvent.click(screen.getByRole("checkbox"));
		await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
		expect(view.memorySet).toHaveBeenCalledWith("first", false);
		fireEvent.click(screen.getByRole("button", { name: zhCN.relationshipMemory.title }));
		await screen.findByText("已有的角色记忆");
	});

	it("does not display an unconfirmed consent change when saving fails", async () => {
		mount(async (request) => response(request.characterId, "stored"), {
			memorySet: async () => {
				throw new Error("Storage unavailable");
			},
		});
		await waitFor(() => expect(screen.getByRole("checkbox")).toBeEnabled());
		fireEvent.click(screen.getByRole("checkbox"));
		await screen.findByText(zhCN.relationshipMemory.consentError);
		expect(screen.getByRole("checkbox")).not.toBeChecked();
	});

	it("discards a late response from the previous character", async () => {
		const first = Promise.withResolvers<MemoryInspectResponse>();
		const second = Promise.withResolvers<MemoryInspectResponse>();
		const view = mount((request) =>
			request.characterId === "first" ? first.promise : second.promise,
		);
		fireEvent.click(screen.getByRole("button", { name: zhCN.relationshipMemory.title }));
		await screen.findByText(zhCN.relationshipMemory.loading);
		view.setCharacterId("second");
		second.resolve(response("second", "第二位角色的记忆"));
		await screen.findByText("第二位角色的记忆");
		first.resolve(response("first", "第一位角色的记忆"));
		await first.promise;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		await waitFor(() => expect(screen.queryByText("第一位角色的记忆")).not.toBeInTheDocument());
		expect(screen.getByText("第二位角色的记忆")).toBeInTheDocument();
	});

	it("pages stored memories and separates explicit content while the automatic service is disabled", async () => {
		mount(async (request) =>
			request.kind === "explicit"
				? {
						characterId: request.characterId,
						relationshipMemoryEnabled: false,
						items: [],
						explicit: "明确约定：不喝咖啡。",
					}
				: {
						...response(request.characterId, request.offset ? "更早的记忆" : "最近的记忆"),
						...(request.offset ? {} : { nextOffset: 20 }),
					},
		);
		fireEvent.click(screen.getByRole("button", { name: zhCN.relationshipMemory.title }));
		await screen.findByText("最近的记忆");
		fireEvent.click(screen.getByRole("button", { name: zhCN.relationshipMemory.next }));
		await screen.findByText("更早的记忆");
		expect(screen.queryByText("最近的记忆")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: zhCN.relationshipMemory.next })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: zhCN.relationshipMemory.explicitTitle }));
		await screen.findByText("明确约定：不喝咖啡。");
		expect(screen.queryByText("更早的记忆")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: zhCN.relationshipMemory.records }));
		await screen.findByText("最近的记忆");
		expect(screen.getByRole("button", { name: zhCN.relationshipMemory.previous })).toBeDisabled();
	});

	it("rejects foreign response content and lets the user retry the failed read", async () => {
		let foreign = true;
		mount(async () =>
			response(foreign ? "other" : "first", foreign ? "别的角色的秘密" : "正确的记忆"),
		);
		fireEvent.click(screen.getByRole("button", { name: zhCN.relationshipMemory.title }));
		await screen.findByRole("alert");
		expect(screen.queryByText("别的角色的秘密")).not.toBeInTheDocument();
		foreign = false;
		fireEvent.click(screen.getByRole("button", { name: zhCN.relationshipMemory.refresh }));
		await screen.findByText("正确的记忆");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
