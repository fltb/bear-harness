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

function mount(load: (request: MemoryInspectRequest) => Promise<MemoryInspectResponse>) {
	const [characterId, setCharacterId] = createSignal("first");
	const onSystemSettings = vi.fn();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(() => (
		<QueryClientProvider client={client}>
			<RelationshipMemory
				characterId={characterId}
				characterName={characterId}
				load={load}
				onSystemSettings={onSystemSettings}
			/>
		</QueryClientProvider>
	));
	return { ...view, setCharacterId, onSystemSettings };
}

describe("relationship memory viewer", () => {
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
