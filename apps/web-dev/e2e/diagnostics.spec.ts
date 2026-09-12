import { readFile } from "node:fs/promises";
import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation, getBootstrap, sendMessage } from "./helpers";

test("diagnostics settings persist and expose real Pi trace payloads without credentials", async ({
	page,
}) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await ensureReadyForConversation(page);
	await sendMessage(page, "Hello diagnostic trace");
	const { token } = await getBootstrap(page);
	const rpc = async (channel: string, data = {}) => {
		const response = await page.request.post(`/rpc/${channel}`, {
			headers: { "x-bear-web-dev-token": token },
			data,
		});
		expect(response.ok()).toBe(true);
		const envelope = await response.json();
		expect(envelope.ok).toBe(true);
		return envelope.data;
	};
	await expect
		.poll(async () => {
			const list = await rpc("diagnostics.list");
			for (const trace of list.traces) {
				const result = await rpc("diagnostics.read", { traceId: trace.traceId });
				if (result.content.includes('"event":"pi.agent.end"')) return true;
			}
			return false;
		})
		.toBe(true);
	const list = await rpc("diagnostics.list");
	let inspected: { traceId: string; eventId: string; conversationId: string } | undefined;
	for (const trace of list.traces) {
		const { content } = await rpc("diagnostics.read", { traceId: trace.traceId });
		expect(content).not.toContain("e2e-rule-key");
		const event = content
			.trim()
			.split("\n")
			.map((line: string) => JSON.parse(line))
			.find((item: { event: string }) => item.event === "pi.message_end");
		if (!event?.payload) continue;
		const body = await rpc("diagnostics.payload", {
			traceId: trace.traceId,
			sha256: event.payload.sha256,
		});
		expect(body.content).not.toContain("e2e-rule-key");
		inspected = {
			traceId: trace.traceId,
			eventId: event.eventId,
			conversationId: event.conversationId,
		};
		break;
	}
	if (!inspected) throw new Error("missing real Pi message payload");
	await rpc("diagnostics.renderer", {
		rendererId: "12345678-1234-4234-8234-123456789012",
		dropped: 0,
		records: [
			{
				conversationId: inspected.conversationId,
				event: "fault",
				at: new Date().toISOString(),
				error: {
					name: "TypeError",
					message: "local UI failure",
					stack: "Authorization: Bearer test-secret",
				},
			},
		],
	});
	const incidents = await rpc("diagnostics.list", { incidents: true, event: "renderer.fault" });
	expect(incidents.traces.length).toBeGreaterThan(0);
	const faultTrace = incidents.traces[0].traceId;
	const faultEvents = (await rpc("diagnostics.read", { traceId: faultTrace })).content
		.split("\n")
		.filter(Boolean)
		.map((line: string) => JSON.parse(line));
	const fault = faultEvents.find((event: { event: string }) => event.event === "renderer.fault");
	expect(fault).toBeDefined();
	const faultBody = await rpc("diagnostics.payload", {
		traceId: faultTrace,
		sha256: fault.payload.sha256,
	});
	expect(faultBody.content).toContain("local UI failure");
	expect(faultBody.content).not.toContain("test-secret");
	await page.getByRole("button", { name: zhCN.sidebar.systemSettings, exact: true }).click();
	await page.getByRole("button", { name: zhCN.settings.diagnosticsTitle, exact: true }).click();
	const settings = page.getByRole("region", { name: zhCN.settings.diagnosticsTitle, exact: true });
	await expect(settings.getByRole("button", { name: "DEBUG", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await settings.getByRole("button", { name: "INFO", exact: true }).click();
	await expect(settings.getByRole("button", { name: "INFO", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	expect((await rpc("diagnostics.get")).policy.level).toBe("info");
	await settings
		.getByRole("button", { name: zhCN.settings.diagnosticsTemporary, exact: true })
		.click();
	await expect
		.poll(async () => (await rpc("diagnostics.get")).policy.traceUntil)
		.toBeGreaterThan(Date.now());
	await settings
		.getByRole("button", { name: zhCN.settings.diagnosticsStopTemporary, exact: true })
		.click();
	await expect.poll(async () => (await rpc("diagnostics.get")).policy.traceUntil).toBe(0);
	await expect(settings.getByRole("button", { name: zhCN.settings.diagnosticsReveal })).toHaveCount(
		0,
	);
	await page.screenshot({ path: "../../test-results/diagnostics-settings.png", fullPage: true });
	await settings
		.getByRole("textbox", { name: zhCN.settings.diagnosticsEventFilter, exact: true })
		.fill("pi.message_end");
	await settings
		.getByRole("textbox", { name: zhCN.settings.diagnosticsEventFilter, exact: true })
		.press("Tab");
	await settings.getByRole("button", { name: `Trace ${inspected.traceId}`, exact: true }).click();
	const pin = settings.getByRole("button", { name: zhCN.settings.diagnosticsPin, exact: true });
	await pin.click();
	await expect(pin).toHaveAttribute("aria-pressed", "true");
	expect((await rpc("diagnostics.read", { traceId: inspected.traceId })).pinned).toBe(true);
	await settings.getByRole("button", { name: zhCN.settings.diagnosticsUnpin, exact: true }).click();
	await expect(pin).toHaveAttribute("aria-pressed", "false");
	await settings.getByLabel(`pi.message_end ${inspected.eventId}`, { exact: true }).click();
	await settings
		.getByRole("button", { name: new RegExp(zhCN.settings.diagnosticsReadPayload) })
		.click();
	await expect(
		settings.getByRole("region", { name: zhCN.settings.diagnosticsPayload, exact: true }),
	).toBeVisible();
	const downloaded = page.waitForEvent("download");
	await settings
		.getByRole("button", { name: zhCN.settings.diagnosticsDownload, exact: true })
		.click();
	const path = await (await downloaded).path();
	if (!path) throw new Error("trace download missing");
	const bundles = (await readFile(path, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(bundles.flatMap((bundle) => bundle.events).length).toBeGreaterThan(0);
	expect(bundles.some((bundle) => Object.keys(bundle.payloads).length > 0)).toBe(true);
	expect(bundles.every((bundle) => bundle.completeness.scope === "observed-events")).toBe(true);
});
