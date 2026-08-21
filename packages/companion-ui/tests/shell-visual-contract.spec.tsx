import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SUPPORTED_DESKTOP_MIN_WIDTH } from "../src/App.js";
import { CharacterPresence } from "../src/CharacterPresence.js";
import { SceneBackdrop } from "../src/SceneBackdrop.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { ThreadHead } from "../src/ThreadHead.js";
import { THEMED_CHARACTER } from "./fixtures.js";

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

describe("shell visual and thread head contracts", () => {
	it("publishes semantic surface roles and a narrow desktop fallback contract", () => {
		expect(SUPPORTED_DESKTOP_MIN_WIDTH).toBe(800);
		for (const token of [
			"--surface-sidebar",
			"--surface-panel",
			"--surface-action",
			"--surface-danger",
			"--text-strong",
			"--text-muted",
			"--focus-ring",
		]) {
			expect(styles).toContain(token);
		}
		expect(styles).toContain("@media (max-width: 1049px)");
		expect(styles).toContain("@media (max-width: 799px)");
		expect(styles).toContain("grid-template-columns: 132px minmax(0, 1fr)");

		render(() => (
			<div
				class="app desktop-shell"
				data-layout="desktop"
				data-supported-min-width={SUPPORTED_DESKTOP_MIN_WIDTH}
				role="application"
				aria-label="Companion"
			>
				<div class="shell">
					<aside class="sidebar" aria-label="Conversations" />
					<main class="main">
						<section class="thread" aria-label="Conversation thread" />
						<form class="composer">
							<textarea aria-label="Message" />
						</form>
					</main>
					<aside class="result-column" aria-label="Results" />
				</div>
			</div>
		));

		const application = screen.getByRole("application", { name: "Companion" });
		expect(application).toHaveAttribute("data-layout", "desktop");
		expect(application).toHaveAttribute("data-supported-min-width", "800");
		expect(within(application).getAllByRole("complementary")).toHaveLength(2);
		expect(within(application).getByRole("textbox", { name: "Message" })).toBeEnabled();
	});

	it("shows an explicit empty state when no work is running", async () => {
		const user = userEvent.setup();
		render(() => (
			<DesktopProvider store={{ runs: [] } as CompanionStore}>
				<ThreadHead sceneTitle="Idle" />
			</DesktopProvider>
		));
		const queue = screen.getByRole("button", { name: /0/ });
		await user.click(queue);
		expect(screen.getByRole("menu", { name: zhCN.threadHead.runningWork })).toHaveTextContent(
			zhCN.threadHead.noRunningWork,
		);
		await user.click(queue);
		expect(
			screen.queryByRole("menu", { name: zhCN.threadHead.runningWork }),
		).not.toBeInTheDocument();
	});

	it("opens the active-run menu, maps status text, and closes with Escape", async () => {
		const user = userEvent.setup();
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
				<ThreadHead sceneTitle="Scene title" />
			</DesktopProvider>
		));

		expect(screen.getByRole("heading", { name: "Scene title" })).toBeVisible();
		const queueButton = screen.getByRole("button", { name: /1/ });
		await user.click(queueButton);
		expect(screen.getByRole("menu", { name: zhCN.threadHead.runningWork })).toHaveTextContent(
			zhCN.threadHead.runStatuses.needs_user,
		);
		await user.keyboard("{Escape}");
		expect(
			screen.queryByRole("menu", { name: zhCN.threadHead.runningWork }),
		).not.toBeInTheDocument();
	});

	it("renders package scene and presence assets with package-owned accessible labels", () => {
		const character = {
			...THEMED_CHARACTER,
			visual: {
				...THEMED_CHARACTER.visual,
				expressions: {
					thinking: "data:image/png;base64,dGhpbmtpbmc=",
					custom: "data:image/png;base64,Y3VzdG9t",
				},
				expressionLabels: { thinking: "Thinking", custom: "Custom expression" },
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
