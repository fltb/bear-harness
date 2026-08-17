import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CharacterPackageWorkshop } from "../src/features/CharacterPackageWorkshop.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";

const createdDraft = {
	id: "draft-1",
	status: "draft" as const,
	locale: "zh-CN",
	currentRevision: 1,
	files: {},
};

describe("character package workshop", () => {
	it("creates a draft and saves the manifest as an explicit UTF-8 patch", async () => {
		const user = userEvent.setup();
		const draftCreate = vi.fn(() => Promise.resolve(createdDraft));
		const draftPatch = vi.fn(() => Promise.resolve({ ...createdDraft, currentRevision: 2 }));
		render(() => (
			<DesktopProvider
				store={
					{
						characters: { draftCreate, draftPatch },
					} as unknown as CompanionStore
				}
			>
				<CharacterPackageWorkshop />
			</DesktopProvider>
		));

		await user.click(screen.getByRole("button", { name: zhCN.packageWorkshop.create }));
		expect(draftCreate).toHaveBeenCalledWith();
		const editor = screen.getByRole("textbox", { name: zhCN.packageWorkshop.manifest });
		await user.clear(editor);
		await user.type(editor, "id: workshop-ui\n");
		await user.click(screen.getByRole("button", { name: zhCN.packageWorkshop.save }));
		expect(draftPatch).toHaveBeenCalledWith("draft-1", {
			"character.yaml": { encoding: "utf8", content: "id: workshop-ui\n" },
		});
	});
});
