import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import {
	activeConversationId,
	ensureReadyForConversation,
	getBootstrap,
	sendMessage,
} from "./helpers";

test("configures and tests a custom ACP worker, selects it explicitly, and downloads its output", async ({
	page,
}) => {
	test.setTimeout(60000);
	await ensureReadyForConversation(page);
	await page.getByRole("button", { name: zhCN.sidebar.systemSettings, exact: true }).click();
	const settings = page.getByRole("dialog", { name: zhCN.sidebar.systemSettings });
	await settings.getByRole("button", { name: zhCN.settings.workAgent, exact: true }).click();
	await expect(settings.getByText("Pi Worker", { exact: true })).toBeVisible();
	await settings.getByRole("button", { name: zhCN.settings.runnerAdd }).click();
	await settings.getByLabel(zhCN.settings.runnerName, { exact: true }).fill("E2E Custom ACP");
	await settings
		.getByLabel(zhCN.settings.runnerDescription, { exact: true })
		.fill("Writes a verifiable ACP output");
	await settings
		.getByLabel(zhCN.settings.runnerUseWhen, { exact: true })
		.fill("Explicit ACP integration checks");
	await settings
		.getByLabel(zhCN.settings.runnerCommand, { exact: true })
		.fill(realpathSync(process.execPath));
	await settings
		.getByLabel(zhCN.settings.runnerArgs, { exact: true })
		.fill(
			fileURLToPath(
				new URL("../../../packages/host-runtime/tests/fixtures/acp-custom.mjs", import.meta.url),
			),
		);
	const saved = page.waitForResponse((response) =>
		response.url().includes("/rpc/externalAgent.save"),
	);
	await settings.getByRole("button", { name: zhCN.settings.runnerSave }).click();
	const envelope = await (await saved).json();
	expect(envelope.ok).toBe(true);
	const runnerId = envelope.data.runner.runnerId;
	const card = settings.getByRole("region", { name: "E2E Custom ACP", exact: true });
	await card.getByRole("button", { name: zhCN.settings.runnerTest }).click();
	await expect(card.getByRole("status")).toContainText("Custom fixture 1");
	await settings.getByRole("button", { name: zhCN.backstage.close }).click();
	await sendMessage(page, `E2E_CUSTOM_RUNNER_${runnerId}`);
	const conversationId = await activeConversationId(page);
	const { token } = await getBootstrap(page);
	const list = async () => {
		const response = await page.request.post("/rpc/run.list", {
			headers: { "x-bear-web-dev-token": token },
			data: { characterId: "jizhou", conversationId },
		});
		const responseData = await response.json();
		expect(responseData.ok).toBe(true);
		return responseData.data.runs;
	};
	await expect
		.poll(
			async () =>
				(await list()).find((run: { executorProfile: string }) => run.executorProfile === runnerId)
					?.status,
		)
		.toBe("completed");
	const run = (await list()).find(
		(run: { executorProfile: string }) => run.executorProfile === runnerId,
	);
	expect(run).toBeTruthy();
	const detailResponse = await page.request.post("/rpc/run.get", {
		headers: { "x-bear-web-dev-token": token },
		data: { characterId: "jizhou", runId: run.id },
	});
	const detail = await detailResponse.json();
	expect(detail.ok).toBe(true);
	expect(detail.data.run.artifacts).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "result.txt", verification: "verified" }),
		]),
	);
	await page
		.getByRole("article", { name: zhCN.messages.toolActivity.externalResult, exact: true })
		.getByRole("button", { name: `${zhCN.work.timeline.viewArtifacts}: result.txt`, exact: true })
		.click();
	const preview = page.getByRole("dialog", { name: "result.txt" });
	const downloading = page.waitForEvent("download");
	await preview.getByRole("button", { name: zhCN.work.download }).click();
	const download = await downloading;
	const path = await download.path();
	if (!path) throw new Error("Missing downloaded output");
	expect(download.suggestedFilename()).toBe("result.txt");
	expect(readFileSync(path, "utf8")).toBe("ACP output");
});
