import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { CharacterPackageWorkshop } from "../src/features/CharacterPackageWorkshop.js";

describe("character package workshop", () => {
	it("directs package authoring to the external specification", () => {
		render(() => <CharacterPackageWorkshop />);

		expect(screen.getByRole("heading", { name: zhCN.packageWorkshop.title })).toBeVisible();
		expect(screen.getByText(zhCN.packageWorkshop.disabledNote)).toBeVisible();
		expect(screen.getByText(zhCN.packageWorkshop.toolRecommendation)).toBeVisible();
		expect(screen.getByRole("link", { name: zhCN.packageWorkshop.openGuide })).toHaveAttribute(
			"href",
			"https://github.com/fltb/bear-harness/blob/main/docs/character-package-authoring.md",
		);
	});
});
