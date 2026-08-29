import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { describe, expect, it } from "vitest";
import type { CompanionStore } from "../src/stores/companion.js";
import { useConversationViewWorkflow } from "../src/stores/conversation-workflows.js";
import { THEMED_CHARACTER } from "./fixtures.js";

describe("Host scene projection", () => {
	it("derives the visible scene label from the active conversation runtime state", () => {
		const character = {
			...THEMED_CHARACTER,
			scenes: [
				...THEMED_CHARACTER.scenes,
				{ id: "quiet", label: "Quiet terminal", description: "Focused work" },
			],
		};
		const [state, setState] = createStore({
			activeConversationId: "conversation-1",
			activePiTimeline: { entries: [] },
			activePiLiveState: { isStreaming: false },
			conversations: [
				{
					id: "conversation-1",
					title: "First",
					unread: false,
					updatedAt: "2026-08-29T00:00:00Z",
				},
			],
			character,
			characterRuntimeByConversation: {},
		});

		createRoot((dispose) => {
			const workflow = useConversationViewWorkflow(state as unknown as CompanionStore);
			expect(workflow.sceneLabel()).toBe("Default");

			setState("characterRuntimeByConversation", "conversation-1", {
				sceneId: "quiet",
				visualState: "default",
			});
			expect(workflow.sceneLabel()).toBe("Quiet terminal");

			setState("activeConversationId", "conversation-2");
			expect(workflow.sceneLabel()).toBe("Default");
			dispose();
		});
	});
});
