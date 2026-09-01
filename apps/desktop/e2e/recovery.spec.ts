import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zhCN } from "@bear-harness/i18n/locales";
import { productConfig } from "@bear-harness/product-config";
import { expect, test } from "playwright/test";
import { launchSourceAppAt } from "./helpers";

test("fatal settings corruption opens isolated recovery and rebuilds on explicit action", async () => {
	const appDataRoot = mkdtempSync(join(tmpdir(), "bear-recovery-e2e-"));
	const dataRoot = join(appDataRoot, productConfig.dataDirectoryName);
	mkdirSync(join(dataRoot, "system"), { recursive: true });
	writeFileSync(join(dataRoot, "system", "settings.db"), "not a sqlite database");
	let first: Awaited<ReturnType<typeof launchSourceAppAt>>["app"] | undefined;
	let restarted: Awaited<ReturnType<typeof launchSourceAppAt>>["app"] | undefined;
	try {
		({ app: first } = await launchSourceAppAt(appDataRoot));
		const recovery = await first.firstWindow();
		await expect(
			recovery.getByRole("heading", { name: `${productConfig.productName} 无法安全启动` }),
		).toBeVisible();
		const closed = first.waitForEvent("close", { timeout: 30_000 });
		await recovery.getByRole("link", { name: "修复数据库并重启" }).click();
		await closed;
		first = undefined;

		({ app: restarted } = await launchSourceAppAt(appDataRoot));
		const setup = await restarted.firstWindow();
		await expect(setup.getByRole("dialog", { name: zhCN.modelSetup.dialogLabel })).toBeVisible();
	} finally {
		await first?.close().catch(() => undefined);
		await restarted?.close().catch(() => undefined);
		rmSync(appDataRoot, { recursive: true, force: true });
	}
});
