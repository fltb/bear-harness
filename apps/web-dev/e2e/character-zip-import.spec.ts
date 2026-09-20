import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import { zipSync } from "fflate";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation } from "./helpers";

const root = fileURLToPath(new URL("../../../config/characters/jizhou", import.meta.url));
function files(
	characterId: string,
	characterName: string,
	directory = root,
): Record<string, Uint8Array> {
	return Object.fromEntries(
		readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return Object.entries(files(characterId, characterName, path));
			const source = readFileSync(path);
			const bytes =
				entry.name === "character.yaml"
					? Buffer.from(
							source
								.toString("utf8")
								.replace(/^id: jizhou$/m, `id: ${characterId}`)
								.replace(/^name: .*$/m, `name: ${characterName}`),
						)
					: source;
			return [[`${characterId}/${relative(root, path)}`, bytes]];
		}),
	);
}

test("GUI retries damaged ZIP and imports large packages beyond former file and HTTP quotas", async ({
	page,
}) => {
	const characterId = `zip-import-${randomUUID()}`;
	const characterName = `ZIP Import Test ${characterId}`;
	await ensureReadyForConversation(page);
	await page.getByRole("button", { name: zhCN.sidebar.characterSettings, exact: true }).click();
	const upload = async (name: string, buffer: Buffer) => {
		const chosen = page.waitForEvent("filechooser");
		await page.getByRole("button", { name: zhCN.backstage.roleImport, exact: true }).click();
		await (await chosen).setFiles({ name, mimeType: "application/zip", buffer });
	};
	await upload("damaged.zip", Buffer.from("damaged"));
	await expect(
		page.getByRole("status").filter({ hasText: zhCN.backstage.roleImportFailed }),
	).toBeVisible();
	const packageFiles = files(characterId, characterName);
	packageFiles[`${characterId}/assets/large.bin`] = new Uint8Array(28 * 1024 * 1024);
	for (let index = 0; index < 501; index++)
		packageFiles[`${characterId}/assets/part-${index}.bin`] = new Uint8Array([index % 256]);
	const archive = Buffer.from(zipSync(packageFiles));
	// Large-package extraction is asynchronous disk work, not a five-second UI
	// latency contract. Bound the actual operation and report RPC failures directly.
	const [finished] = await Promise.all([
		page.waitForResponse("**/rpc/character.archiveFinish", { timeout: 20_000 }),
		upload("character.zip", archive),
	]);
	expect(finished.ok()).toBe(true);
	await expect(
		page.getByRole("status").filter({ hasText: zhCN.backstage.roleImportDone }),
	).toBeVisible();
	await expect(
		page.getByRole("dialog").getByRole("article", { name: characterName, exact: true }),
	).toBeVisible();
	await page.reload();
	await page.getByRole("button", { name: zhCN.sidebar.characterSettings, exact: true }).click();
	await expect(
		page.getByRole("dialog").getByRole("article", { name: characterName, exact: true }),
	).toBeVisible();
});
