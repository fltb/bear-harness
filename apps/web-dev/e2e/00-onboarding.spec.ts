import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation, selectKobalteOption } from "./helpers";

test("browser requires a reply model before the role-defined onboarding", async ({ page }) => {
	let eventRequests = 0;
	page.on("request", (request) => {
		if (request.url().includes("/events/invalidations")) {
			eventRequests++;
			expect(request.headers().accept).toBe("application/x-ndjson");
		}
	});
	const provider = {
		id: "e2e-rule",
		name: "E2E Rule Provider",
		modelId: "rule-model",
	};
	await page.goto("/");
	const licenseNotice = page.getByRole("dialog", {
		name: zhCN.licenseNotice.dialogLabel,
	});
	await expect(licenseNotice).toBeVisible();
	await expect(
		licenseNotice.getByRole("heading", { name: zhCN.licenseNotice.bearTitle }),
	).toBeVisible();
	const gitHeading = licenseNotice.getByRole("heading", { name: zhCN.licenseNotice.gitTitle });
	if (process.platform === "win32") await expect(gitHeading).toBeVisible();
	else await expect(gitHeading).toHaveCount(0);
	const licenseContinue = licenseNotice.getByRole("button", {
		name: zhCN.licenseNotice.continue,
	});
	await expect(licenseContinue).toBeDisabled();
	const confirmationLabel =
		process.platform === "win32"
			? zhCN.licenseNotice.confirmWindows
			: zhCN.licenseNotice.confirmBear;
	const confirmation = licenseNotice.getByRole("checkbox", { name: confirmationLabel });
	await licenseNotice.getByText(confirmationLabel, { exact: true }).click();
	await expect(confirmation).toBeChecked();
	await expect(licenseContinue).toBeEnabled();
	await licenseContinue.click();
	await expect(licenseNotice).toBeHidden();
	const modelSetup = page.getByRole("dialog", {
		name: zhCN.modelSetup.dialogLabel,
	});
	await expect(modelSetup).toBeVisible();
	await expect(modelSetup.getByRole("heading", { name: zhCN.modelSetup.title })).toBeVisible();
	const providerSetup = modelSetup.getByRole("region", {
		name: zhCN.settings.providerSetupLabel,
	});
	await providerSetup.getByText(zhCN.settings.advancedToggle, { exact: true }).click();
	await providerSetup
		.getByRole("textbox", { name: zhCN.settings.customProviderId })
		.fill(provider.id);
	await providerSetup
		.getByRole("textbox", { name: zhCN.settings.customServiceName })
		.fill(provider.name);
	await providerSetup
		.getByRole("textbox", { name: zhCN.settings.customBaseUrl })
		.fill(`http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}/v1`);
	await providerSetup
		.getByRole("textbox", { name: zhCN.settings.customModels })
		.fill(provider.modelId);
	await providerSetup
		.getByRole("textbox", { name: zhCN.settings.apiKeyLabel })
		.fill("e2e-rule-key");
	await providerSetup.getByRole("button", { name: zhCN.settings.addProvider }).click();
	const replyModel = modelSetup.getByRole("button", { name: zhCN.modelSetup.modelLabel });
	await expect(replyModel).toBeVisible();
	await test.step("explicit model selection enables the uncommitted system draft", async () => {
		await selectKobalteOption(page, replyModel, /rule-model/);
		await expect(replyModel).toContainText(provider.modelId);
		await expect(modelSetup.getByRole("button", { name: zhCN.modelSetup.continue })).toBeEnabled();
	});
	expect(eventRequests).toBeGreaterThanOrEqual(1);
	await modelSetup.getByRole("button", { name: zhCN.modelSetup.continue }).click();
	const embeddingSetup = page.getByRole("dialog", {
		name: zhCN.settings.memoryVectorSection,
	});
	await expect(embeddingSetup).toBeVisible();
	// System model selection is an unsaved draft until Continue commits it.
	// A new renderer resumes the Host-owned embedding stage after that commit.
	await test.step("reload resumes embedding after the system model commit", async () => {
		await page.reload();
		await expect(licenseNotice).toBeHidden();
		await expect(modelSetup).toBeHidden();
		await expect(embeddingSetup).toBeVisible();
	});
	const embeddingContinue = embeddingSetup.getByRole("button", {
		name: zhCN.messages.continue,
	});
	await expect(embeddingContinue).toBeEnabled();
	await embeddingContinue.click();

	await expect(modelSetup).toBeVisible();
	await expect(modelSetup.getByRole("heading", { name: zhCN.modelSetup.roleTitle })).toBeVisible();
	await expect(modelSetup.getByRole("button", { name: zhCN.modelSetup.confirmRole })).toBeEnabled();
	// A renderer restart after system setup resumes at the character-owned route
	// confirmation and never repeats providers or embedding.
	await page.reload();
	await expect(embeddingSetup).toBeHidden();
	await expect(modelSetup).toBeVisible();
	await expect(modelSetup.getByRole("heading", { name: zhCN.modelSetup.roleTitle })).toBeVisible();
	await modelSetup.getByRole("button", { name: zhCN.modelSetup.confirmRole }).click();

	const onboarding = page.getByRole("dialog", { name: "开始相处" });
	await expect(onboarding).toBeVisible();
	// Setup progress is Host-owned: a new renderer resumes role onboarding and
	// never regresses to either system or character model setup.
	await page.reload();
	await expect(modelSetup).toBeHidden();
	await expect(embeddingSetup).toBeHidden();
	await expect(onboarding).toBeVisible();
	const [submitResponse] = await Promise.all([
		page.waitForResponse((response) => response.url().includes("/rpc/onboarding.submit")),
		onboarding.getByRole("button", { name: "认识一下" }).click(),
	]);
	const submitted = await submitResponse.json();
	expect(submitted.ok).toBe(true);
	expect(submitted.data.currentStepId).toBe("nickname");
	await expect.poll(() => onboarding.getAttribute("data-onboarding-step")).toBe("nickname");
	await onboarding.getByRole("textbox", { name: "你的称呼" }).fill("林");
	await onboarding.getByRole("button", { name: "告诉他" }).click();

	await expect(onboarding).toBeHidden();
	await expect(page.getByRole("button", { name: "Web Dev" })).toBeVisible();
	await page.reload();
	await expect(onboarding).toBeHidden();
	await expect(page.getByRole("button", { name: "Web Dev" })).toBeVisible();
	expect(eventRequests).toBeGreaterThanOrEqual(3); // one persistent connection per observed page load
});

test("completed onboarding never mounts a setup dialog while reload authority is pending", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	await page.addInitScript(() => {
		const probe = window as typeof window & { onboardingDialogMounts: number };
		probe.onboardingDialogMounts = 0;
		const dialogs = new Set<Element>();
		const recordDialog = (element: Element) => {
			if (element.getAttribute("role") === "dialog" && !dialogs.has(element)) {
				dialogs.add(element);
				probe.onboardingDialogMounts++;
			}
		};
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				if (record.type === "attributes" && record.target instanceof Element) {
					recordDialog(record.target);
				}
				for (const node of record.addedNodes) {
					if (node instanceof Element) recordDialog(node);
					const descendants = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
					while (descendants.nextNode()) recordDialog(descendants.currentNode as Element);
				}
			}
		});
		observer.observe(document, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["role"],
		});
	});
	const holds = ["model.defaults.get", "onboarding.get"].map((channel) => ({
		channel,
		arrived: Promise.withResolvers<void>(),
		release: Promise.withResolvers<void>(),
	}));
	for (const hold of holds) {
		await page.route(`**/rpc/${hold.channel}`, async (route) => {
			const response = await route.fetch();
			expect(response.ok()).toBe(true);
			const body = await response.json();
			expect(body).toMatchObject(
				hold.channel === "onboarding.get"
					? { ok: true, data: { status: "complete" } }
					: { ok: true, data: { onboardingComplete: true } },
			);
			hold.arrived.resolve();
			await hold.release.promise;
			await route.fulfill({ response });
		});
	}
	const expectNoDialogMounts = async () => {
		// Cross a browser paint boundary so the mutation observer includes the
		// current render, including any dialog inserted and removed in that render.
		const mounts = await page.evaluate(async () => {
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			return (window as typeof window & { onboardingDialogMounts: number }).onboardingDialogMounts;
		});
		expect(mounts).toBe(0);
		await expect(page.getByRole("dialog")).toHaveCount(0);
	};
	try {
		await page.reload();
		await Promise.all(holds.map((hold) => hold.arrived.promise));
		await expect(page.getByRole("application", { name: zhCN.shell.productName })).toBeVisible();
		await expectNoDialogMounts();
		// Model authority resolves first; onboarding is still unknown, not incomplete.
		for (const hold of holds) {
			const delivered = page.waitForResponse(
				(response) => new URL(response.url()).pathname === `/rpc/${hold.channel}`,
			);
			hold.release.resolve();
			await (await delivered).finished();
			await expectNoDialogMounts();
		}
		await expect(
			page.getByRole("textbox", { name: zhCN.composer.messageInputLabel }),
		).toBeEnabled();
		await expectNoDialogMounts();
	} finally {
		for (const hold of holds) hold.release.resolve();
		await page.unrouteAll({ behavior: "wait" });
	}
});
