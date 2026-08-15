import { productUi } from "@bear-harness/product-config";
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
		expect(
			screen.getByPlaceholderText(productUi.shell.fallbackComposerPlaceholder),
		).toBeInTheDocument();
	});

	it("renders the fork-identity shell with accessibility landmarks", () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={FORK_PRODUCT} client={client} />);

		expect(
			screen.getByRole("navigation", { name: productUi.sidebar.conversations }),
		).toBeInTheDocument();
		expect(screen.getByRole("searchbox", { name: productUi.sidebar.search })).toBeEnabled();
		expect(
			screen.getByRole("button", { name: productUi.sidebar.relationshipArchive }),
		).toBeEnabled();
		expect(screen.getByRole("button", { name: productUi.sidebar.systemSettings })).toBeEnabled();
	});
});
