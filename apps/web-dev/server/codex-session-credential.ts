import { readFileSync, realpathSync } from "node:fs";

type SessionProviderCredential = {
	providerId: "openai-codex";
	credential: {
		type: "oauth";
		access: string;
		refresh: string;
		expires: number;
		accountId: string;
	};
};

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Codex session document must be an object");
	}
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Codex session is missing ${field}`);
	}
	return value;
}

function accessClaims(accessToken: string): Record<string, unknown> {
	const parts = accessToken.split(".");
	if (parts.length !== 3 || !parts[1]) throw new Error("Codex access token is not a JWT");
	try {
		return record(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
	} catch (cause) {
		throw new Error("Codex access token payload is invalid", { cause });
	}
}

export function readCodexSessionCredential(sourcePath: string): SessionProviderCredential {
	const source = realpathSync.native(sourcePath);
	const document = record(JSON.parse(readFileSync(source, "utf8")));
	const tokens = record(document.tokens);
	const access = requiredString(tokens.access_token, "access_token");
	const refresh = requiredString(tokens.refresh_token, "refresh_token");
	const accountId = requiredString(tokens.account_id, "account_id");
	const claims = accessClaims(access);
	if (typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp)) {
		throw new Error("Codex access token has no valid expiry");
	}
	const expires = claims.exp * 1_000;
	if (expires <= Date.now()) throw new Error("Codex access token has expired");
	const auth = record(claims["https://api.openai.com/auth"]);
	if (auth.chatgpt_account_id !== accountId) {
		throw new Error("Codex access token account does not match the session");
	}
	return {
		providerId: "openai-codex",
		credential: { type: "oauth", access, refresh, expires, accountId },
	};
}
