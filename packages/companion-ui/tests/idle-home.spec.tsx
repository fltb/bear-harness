import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";

describe("idle homepage (official config, no bridge)", () => {
	it("renders app title and the shell frame", () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		expect(document.title).toBe("Cyber Bear");
		// Without a bridge, character data is absent — the shell shows the
		// scene area and accessible controls but no character-specific copy.
		expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
		expect(screen.getByPlaceholderText("说点什么…")).toBeInTheDocument();
	});

	it("does not probe pi-ai providers until a user opens provider configuration", async () => {
		const { client, conversationList, providerList } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await waitFor(() => expect(conversationList).toHaveBeenCalled());
		expect(providerList).not.toHaveBeenCalled();
	});

	it("keeps the shell with accessibility landmarks", () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		expect(screen.getByRole("navigation", { name: "对话" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /搜索/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: "关系档案" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "系统设置" })).toBeDisabled();
	});

	it("opens the backstage sheet from the titlebar", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const backstage = screen.getByRole("button", { name: "幕后" });
		expect(backstage).toBeEnabled();
		await user.click(backstage);
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "关系档案" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "记忆" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "系统设置" })).toBeInTheDocument();
	});
});
