import { zhCN } from "@bear-harness/product-config/locales";
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, FORK_PRODUCT } from "./fixtures.js";

describe("idle homepage (fork config injection, no bridge)", () => {
	it("renders the fork app title and shell frame", () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={FORK_PRODUCT} client={client} />);

		expect(document.title).toBe("North Companion");
		// Character content comes only from the character package via the
		// bridge — no hardcoded fork strings in product.config.
		expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
		expect(screen.getByPlaceholderText(zhCN.shell.fallbackComposerPlaceholder)).toBeInTheDocument();
	});

	it("renders the fork-identity shell with accessibility landmarks", () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={FORK_PRODUCT} client={client} />);

		expect(
			screen.getByRole("navigation", { name: zhCN.sidebar.conversations }),
		).toBeInTheDocument();
		expect(screen.getByRole("searchbox", { name: zhCN.sidebar.search })).toBeEnabled();
		expect(screen.getByRole("button", { name: zhCN.sidebar.characterSettings })).toBeEnabled();
		expect(screen.getByRole("button", { name: zhCN.sidebar.systemSettings })).toBeEnabled();
	});
});
