export function hostToolPayload(details: unknown): Record<string, unknown> | undefined {
	if (!details || typeof details !== "object" || !("ok" in details) || details.ok !== true) return;
	if (!("data" in details) || !details.data || typeof details.data !== "object") return;
	return details.data as Record<string, unknown>;
}

export function hostChoices(payload: Record<string, unknown> | undefined) {
	if (!payload || typeof payload.prompt !== "string" || !Array.isArray(payload.items)) return;
	const items = payload.items.filter((item): item is { label: string; message: string } =>
		Boolean(
			item &&
				typeof item === "object" &&
				"label" in item &&
				typeof item.label === "string" &&
				"message" in item &&
				typeof item.message === "string",
		),
	);
	return items.length ? { prompt: payload.prompt, items } : undefined;
}
