import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCodexSessionCredential } from "./codex-session-credential.ts";

function jwt(payload: Record<string, unknown>): string {
	return [
		Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
		Buffer.from(JSON.stringify(payload)).toString("base64url"),
		"signature",
	].join(".");
}

test("maps a current Codex session to a Pi openai-codex OAuth credential", () => {
	const root = mkdtempSync(join(tmpdir(), "bear-codex-session-"));
	const source = join(root, "auth.json");
	try {
		const expires = Math.floor(Date.now() / 1000) + 3_600;
		writeFileSync(
			source,
			JSON.stringify({
				tokens: {
					access_token: jwt({
						exp: expires,
						"https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
					}),
					refresh_token: "refresh-1",
					account_id: "account-1",
				},
			}),
			{ mode: 0o600 },
		);

		const result = readCodexSessionCredential(source);
		assert.equal(result.providerId, "openai-codex");
		assert.equal(result.credential.type, "oauth");
		assert.equal(result.credential.refresh, "refresh-1");
		assert.equal(result.credential.expires, expires * 1_000);
		assert.equal(result.credential.accountId, "account-1");
		assert.ok(result.credential.access.length > 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects expired and account-mismatched Codex sessions", () => {
	const root = mkdtempSync(join(tmpdir(), "bear-codex-session-invalid-"));
	const source = join(root, "auth.json");
	try {
		writeFileSync(
			source,
			JSON.stringify({
				tokens: {
					access_token: jwt({
						exp: Math.floor(Date.now() / 1000) - 60,
						"https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
					}),
					refresh_token: "refresh-1",
					account_id: "account-2",
				},
			}),
		);
		assert.throws(() => readCodexSessionCredential(source));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
