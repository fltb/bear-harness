import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";
import { selectKobalteOption } from "./kobalte-helpers.js";

const setProductLocale = vi.hoisted(() => vi.fn());

vi.mock("@bear-harness/i18n", async (importOriginal) => ({
	...(await importOriginal<typeof import("@bear-harness/i18n")>()),
	setProductLocale,
}));

it("reports both Error and non-Error language update failures", async () => {
	const user = userEvent.setup();
	const { client } = createTestClient();
	render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

	await user.click(screen.getByRole("button", { name: zhCN.sidebar.systemSettings }));
	const settings = await screen.findByRole("dialog", { name: zhCN.sidebar.systemSettings });
	await user.click(within(settings).getByRole("button", { name: zhCN.settings.language }));
	const languageSettings = within(settings).getByRole("region", {
		name: zhCN.settings.language,
	});
	const languageTrigger = within(languageSettings).getByRole("button");

	setProductLocale.mockRejectedValueOnce(new Error("language service unavailable"));
	await selectKobalteOption(user, languageTrigger, "en");
	await waitFor(() =>
		expect(within(settings).getByRole("alert")).toHaveTextContent("language service unavailable"),
	);

	setProductLocale.mockRejectedValueOnce("locale rejected");
	await selectKobalteOption(user, languageTrigger, "zh-TW");
	await waitFor(() =>
		expect(within(settings).getByRole("alert")).toHaveTextContent("locale rejected"),
	);
});
