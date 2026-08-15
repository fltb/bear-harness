import { productUi } from "@bear-harness/product-config";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CharacterPresence } from "../src/CharacterPresence.js";
import { SceneBackdrop } from "../src/SceneBackdrop.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { Titlebar } from "../src/Titlebar.js";
import { THEMED_CHARACTER } from "./fixtures.js";

describe("shell visual and titlebar contracts", () => {
	it("shows an explicit empty state when no work is running", async () => {
		const user = userEvent.setup();
		render(() => (
			<DesktopProvider store={{ runs: [] } as CompanionStore}>
				<Titlebar sceneTitle="Idle" onOpenBackstage={() => undefined} />
			</DesktopProvider>
		));
		const queue = screen.getByRole("button", { name: /0/ });
		await user.click(queue);
		expect(screen.getByRole("menu", { name: productUi.titlebar.runningWork })).toHaveTextContent(
			productUi.titlebar.noRunningWork,
		);
		await user.click(queue);
		expect(
			screen.queryByRole("menu", { name: productUi.titlebar.runningWork }),
		).not.toBeInTheDocument();
	});

	it("opens the active-run menu, maps status text, closes with Escape, and opens backstage", async () => {
		const user = userEvent.setup();
		const onOpenBackstage = vi.fn();
		const store = {
			runs: [
				{
					id: "run-1",
					commissionId: "commission-1",
					executorProfile: "pi",
					status: "needs_user",
				},
				{
					id: "run-2",
					commissionId: "commission-2",
					executorProfile: "pi",
					status: "completed",
				},
			],
		} as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<Titlebar sceneTitle="Scene title" onOpenBackstage={onOpenBackstage} />
			</DesktopProvider>
		));

		expect(screen.getByRole("heading", { name: "Scene title" })).toBeVisible();
		const queueButton = screen.getByRole("button", { name: /1/ });
		await user.click(queueButton);
		expect(screen.getByRole("menu", { name: productUi.titlebar.runningWork })).toHaveTextContent(
			productUi.titlebar.runStatuses.needs_user,
		);
		await user.keyboard("{Escape}");
		expect(
			screen.queryByRole("menu", { name: productUi.titlebar.runningWork }),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: productUi.titlebar.backstage }));
		expect(onOpenBackstage).toHaveBeenCalledOnce();
	});

	it("renders package scene and presence assets with package-owned accessible labels", () => {
		const character = {
			...THEMED_CHARACTER,
			visual: {
				...THEMED_CHARACTER.visual,
				presence: {
					thinking: "data:image/png;base64,dGhpbmtpbmc=",
					custom: "data:image/png;base64,Y3VzdG9t",
				},
				stateLabels: { thinking: "Thinking", custom: "Custom expression" },
			},
		};
		render(() => (
			<>
				<SceneBackdrop
					scene={{
						id: "room",
						label: "Reading room",
						backgroundUrl: "data:image/png;base64,cm9vbQ==",
					}}
				/>
				<CharacterPresence character={character} presence="thinking" />
			</>
		));
		expect(screen.getByRole("img", { name: "Reading room" })).toBeVisible();
		expect(screen.getByRole("img", { name: "Thinking" })).toBeVisible();

		render(() => <CharacterPresence character={character} presence="idle" visualState="custom" />);
		expect(screen.getByRole("img", { name: "Custom expression" })).toBeVisible();
	});
});
