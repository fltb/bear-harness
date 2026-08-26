// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthInteraction, ProviderCatalog } from "../src/providers/catalog.js";
import { CredentialStore, type CredentialVault } from "../src/providers/credential-store.js";

type RuntimeLogin = (
	providerId: string,
	type: string,
	interaction: AuthInteraction,
) => Promise<unknown>;

/** Scriptable fake pi-ai runtime; the catalog's only external surface is ModelRuntime.login. */
const runtime = vi.hoisted(() => ({
	login: undefined as undefined | RuntimeLogin,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	ModelRuntime: {
		create: vi.fn(async () => ({
			login: (providerId: string, type: string, interaction: AuthInteraction) => {
				if (!runtime.login) return Promise.reject(new Error("login not scripted"));
				return runtime.login(providerId, type, interaction);
			},
			getProvider: () => undefined,
		})),
	},
}));

const vault: CredentialVault = {
	securityLevel: "os",
	isEncryptionAvailable: () => true,
	encryptString: (plaintext) => Buffer.from(plaintext),
	decryptString: (blob) => blob.toString("utf8"),
};

function oauthCredential(): unknown {
	return { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 };
}

const tempRoots: string[] = [];

function makeCatalog(): ProviderCatalog {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE provider_accounts (
			id TEXT PRIMARY KEY,
			provider_id TEXT NOT NULL,
			credential_blob BLOB,
			credential_status TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL
		)
	`);
	const agentDir = mkdtempSync(join(tmpdir(), "bear-oauth-catalog-"));
	tempRoots.push(agentDir);
	return new ProviderCatalog(new CredentialStore(drizzle({ client: db }), vault), agentDir);
}

describe("ProviderCatalog OAuth contract", () => {
	afterEach(() => {
		runtime.login = undefined;
		vi.clearAllMocks();
		for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("projects pi-ai auth events (info links, progress, auth_url instructions) verbatim", async () => {
		const catalog = makeCatalog();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		runtime.login = vi.fn(async (_providerId, _type, interaction) => {
			interaction.notify({
				type: "info",
				message: "Complete login in your browser.",
				links: [{ url: "https://help.example/oauth", label: "Help" }],
			});
			interaction.notify({ type: "progress", message: "Waiting for authorization…" });
			interaction.notify({
				type: "auth_url",
				url: "https://auth.example/start?client=1",
				instructions: "Open the page and finish there.",
			});
			await gate;
			return oauthCredential();
		});
		catalog.startOAuth("openai-codex");
		await vi.waitFor(() => {
			expect(catalog.getOAuthSession("openai-codex").authUrl).toBe(
				"https://auth.example/start?client=1",
			);
		});
		expect(catalog.getOAuthSession("openai-codex")).toMatchObject({
			providerId: "openai-codex",
			status: "running",
			authUrl: "https://auth.example/start?client=1",
			instructions: "Open the page and finish there.",
			message: "Waiting for authorization…",
			infoLinks: [{ url: "https://help.example/oauth", label: "Help" }],
		});
		release!();
		await vi.waitFor(() => {
			expect(catalog.getOAuthSession("openai-codex").status).toBe("completed");
		});
		expect(catalog.getOAuthSession("openai-codex").prompt).toBeUndefined();
	});

	it("projects device_code metadata (verification URI, interval, expiry) verbatim", async () => {
		const catalog = makeCatalog();
		runtime.login = vi.fn(async (_providerId, _type, interaction) => {
			interaction.notify({
				type: "device_code",
				userCode: "ABCD-EFGH",
				verificationUri: "https://auth.example/device",
				intervalSeconds: 5,
				expiresInSeconds: 600,
			});
			return oauthCredential();
		});
		catalog.startOAuth("openai-codex");
		await vi.waitFor(() => {
			expect(catalog.getOAuthSession("openai-codex").deviceCode).toBe("ABCD-EFGH");
		});
		expect(catalog.getOAuthSession("openai-codex")).toMatchObject({
			deviceCode: "ABCD-EFGH",
			verificationUri: "https://auth.example/device",
			intervalSeconds: 5,
			expiresInSeconds: 600,
		});
	});

	it("surfaces a select prompt, routes the answer through answerOAuth, and clears the prompt on completion", async () => {
		const catalog = makeCatalog();
		let answered: string | undefined;
		runtime.login = vi.fn(async (_providerId, _type, interaction) => {
			answered = await interaction.prompt({
				type: "select",
				message: "Choose an account",
				options: [{ id: "personal", label: "Personal" }],
			});
			interaction.notify({ type: "progress", message: "Exchanging token…" });
			return oauthCredential();
		});
		const initial = catalog.startOAuth("openai-codex");
		expect(initial.status).toBe("running");
		await vi.waitFor(() => {
			expect(catalog.getOAuthSession("openai-codex").status).toBe("waiting_input");
		});
		expect(catalog.getOAuthSession("openai-codex").prompt).toMatchObject({
			type: "select",
			message: "Choose an account",
			options: [{ id: "personal", label: "Personal" }],
		});
		const afterAnswer = catalog.answerOAuth("openai-codex", "personal");
		expect(afterAnswer.status).toBe("running");
		await vi.waitFor(() => {
			expect(catalog.getOAuthSession("openai-codex").status).toBe("completed");
		});
		expect(answered).toBe("personal");
		expect(catalog.getOAuthSession("openai-codex").prompt).toBeUndefined();
	});

	it("rejects answers when no prompt is pending", () => {
		const catalog = makeCatalog();
		runtime.login = vi.fn(async () => oauthCredential());
		catalog.startOAuth("openai-codex");
		expect(() => catalog.answerOAuth("openai-codex", "stale")).toThrowError(
			expect.objectContaining({ kind: "conflict", reason: "oauth_input_not_requested" }),
		);
	});

	it("cancels an in-flight flow through the abort signal and drops the session", async () => {
		const catalog = makeCatalog();
		let capturedSignal: AbortSignal | undefined;
		runtime.login = vi.fn(async (_providerId, _type, interaction) => {
			capturedSignal = interaction.signal;
			await new Promise<void>((_resolve, reject) => {
				capturedSignal!.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			});
			return oauthCredential();
		});
		catalog.startOAuth("openai-codex");
		await vi.waitFor(() => expect(capturedSignal).toBeDefined());
		expect(capturedSignal!.aborted).toBe(false);
		catalog.cancelOAuth("openai-codex");
		expect(() => catalog.getOAuthSession("openai-codex")).toThrowError(
			expect.objectContaining({ kind: "not_found", reason: "oauth_session_not_found" }),
		);
	});

	it("rejects a pending interaction prompt when the flow is cancelled", async () => {
		const catalog = makeCatalog();
		let loginSettled = false;
		runtime.login = vi.fn(async (_providerId, _type, interaction) => {
			try {
				await interaction.prompt({
					type: "manual_code",
					message: "Paste the authorization code",
				});
			} finally {
				loginSettled = true;
			}
			return oauthCredential();
		});
		catalog.startOAuth("openai-codex");
		await vi.waitFor(() => {
			expect(catalog.getOAuthSession("openai-codex").status).toBe("waiting_input");
		});
		catalog.cancelOAuth("openai-codex");
		await vi.waitFor(() => expect(loginSettled).toBe(true));
		expect(() => catalog.getOAuthSession("openai-codex")).toThrowError(
			expect.objectContaining({ kind: "not_found", reason: "oauth_session_not_found" }),
		);
	});

	it("honors provider-owned prompt cancellation while the login continues", async () => {
		const catalog = makeCatalog();
		const promptAbort = new AbortController();
		runtime.login = vi.fn(async (_providerId, _type, interaction) => {
			await expect(
				interaction.prompt({
					type: "manual_code",
					message: "Paste the authorization code",
					signal: promptAbort.signal,
				}),
			).rejects.toMatchObject({ name: "AbortError" });
			return oauthCredential();
		});
		catalog.startOAuth("openai-codex");
		await vi.waitFor(() => {
			expect(catalog.getOAuthSession("openai-codex").status).toBe("waiting_input");
		});
		promptAbort.abort();
		await vi.waitFor(() => {
			expect(catalog.getOAuthSession("openai-codex")).toMatchObject({
				status: "completed",
				prompt: undefined,
			});
		});
	});
	it("records the real failure reason on a failed session", async () => {
		const catalog = makeCatalog();
		runtime.login = vi.fn(async () => {
			throw new Error("token exchange failed: invalid_grant");
		});
		catalog.startOAuth("openai-codex");
		await vi.waitFor(() => {
			expect(catalog.getOAuthSession("openai-codex").status).toBe("failed");
		});
		expect(catalog.getOAuthSession("openai-codex").message).toBe(
			"token exchange failed: invalid_grant",
		);
	});

	it("passes host-thrown reason codes through on failure", async () => {
		const catalog = makeCatalog();
		runtime.login = vi.fn(async () => {
			throw { kind: "invalid_request", reason: "login_not_supported" };
		});
		catalog.startOAuth("openai-codex");
		await vi.waitFor(() => {
			expect(catalog.getOAuthSession("openai-codex").status).toBe("failed");
		});
		expect(catalog.getOAuthSession("openai-codex").message).toBe("login_not_supported");
	});

	it("returns the in-flight session when reauth collides with an active flow", async () => {
		const catalog = makeCatalog();
		runtime.login = vi.fn(async (_providerId, _type, interaction) => {
			interaction.notify({ type: "progress", message: "polling device code…" });
			await new Promise<void>(() => undefined); // never settles
			return oauthCredential();
		});
		const first = catalog.startOAuth("openai-codex");
		await vi.waitFor(() => {
			expect(catalog.getOAuthSession("openai-codex").message).toBe("polling device code…");
		});
		const second = catalog.startOAuth("openai-codex");
		expect(second).toMatchObject({ providerId: "openai-codex", status: "running" });
		expect(runtime.login).toHaveBeenCalledTimes(1);
		catalog.cancelOAuth("openai-codex");
	});

	it("aborts in-flight sessions on dispose", async () => {
		const catalog = makeCatalog();
		let capturedSignal: AbortSignal | undefined;
		runtime.login = vi.fn(async (_providerId, _type, interaction) => {
			capturedSignal = interaction.signal;
			await new Promise<void>((_resolve, reject) => {
				capturedSignal!.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			});
			return oauthCredential();
		});
		catalog.startOAuth("openai-codex");
		await vi.waitFor(() => expect(capturedSignal).toBeDefined());
		catalog.dispose();
		expect(capturedSignal!.aborted).toBe(true);
	});
});
