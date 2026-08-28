const SECRET_PATTERNS: readonly RegExp[] = [
	/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g,
	/\b(?:api[-_ ]?key|authorization|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret)\b\s*[:=]\s*["']?[^\s,"'}]+/gi,
	/"(?:apiKey|api_key|authorization|accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|password)"\s*:\s*"[^"]*"/gi,
];

const USER_PATHS: readonly RegExp[] = [
	/\/Users\/[^/\s,"'}]+(?:\/[^\s,"'}]+)*/g,
	/\/home\/[^/\s,"'}]+(?:\/[^\s,"'}]+)*/g,
	/[A-Za-z]:\\Users\\[^\\\s,"'}]+(?:\\[^\s,"'}]+)*/g,
];

const ABSOLUTE_PATHS: readonly RegExp[] = [
	/\/(?:private|tmp|var|opt|etc|usr|Volumes)(?:\/[^\s,"'}]+){2,}/g,
	/[A-Za-z]:\\(?!Users\\)(?:[^\\\s,"'}]+\\){1,}[^\\\s,"'}]+/g,
];

export interface RedactedTraceText {
	content: string;
	originalBytes: number;
	truncated: boolean;
}

function truncateUtf8(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
	return bytes.subarray(0, end).toString("utf8");
}

/** Redact credentials and user-home path segments before TRACE persistence. */
export function redactTraceText(value: string, maxBytes = 4096): RedactedTraceText {
	const originalBytes = Buffer.byteLength(value, "utf8");
	let content = value;
	for (const pattern of SECRET_PATTERNS) content = content.replace(pattern, "[REDACTED_SECRET]");
	for (const pattern of USER_PATHS) content = content.replace(pattern, "[REDACTED_HOME]");
	for (const pattern of ABSOLUTE_PATHS) content = content.replace(pattern, "[REDACTED_PATH]");
	const redactedBytes = Buffer.byteLength(content, "utf8");
	const truncated = redactedBytes > maxBytes;
	if (truncated) content = truncateUtf8(content, maxBytes);
	return { content, originalBytes, truncated };
}
