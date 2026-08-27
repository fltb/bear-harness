import { describe, expect, it } from "vitest";
import { hasTurnAuthorization } from "../src/companion/turn-authorization.js";

describe("turn capability authorization", () => {
	it("requires an explicit current-turn history reference", () => {
		expect(hasTurnAuthorization("我们之前聊过什么？", "history")).toBe(true);
		expect(hasTurnAuthorization("Search our previous conversation", "history")).toBe(true);
		expect(hasTurnAuthorization("帮我回答这个问题", "history")).toBe(false);
	});

	it("requires delegation intent and names Codex for Codex runs", () => {
		expect(hasTurnAuthorization("把附件交给代理单独处理", "delegate_pi")).toBe(true);
		expect(hasTurnAuthorization("Delegate this attachment to Codex", "delegate_codex")).toBe(true);
		expect(hasTurnAuthorization("用 Codex 的风格回答", "delegate_codex")).toBe(false);
		expect(hasTurnAuthorization("交给代理处理", "delegate_codex")).toBe(false);
	});
});
