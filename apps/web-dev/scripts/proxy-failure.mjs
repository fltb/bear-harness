const ROUTES = ["bootstrap", "rpc", "events", "attachment", "diagnostics", "debug"];

function boundedErrorCode(error) {
	const value = error && typeof error === "object" && "code" in error ? error.code : undefined;
	if (typeof value !== "string" || value.length < 1 || value.length > 40) return "unknown";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		const upper = code >= 65 && code <= 90;
		const digit = code >= 48 && code <= 57;
		if (!upper && !digit && character !== "_") return "unknown";
	}
	return value;
}

function routeCategory(url) {
	if (typeof url !== "string") return "unknown";
	for (const route of ROUTES) {
		if (url === `/${route}` || url.startsWith(`/${route}?`) || url.startsWith(`/${route}/`)) {
			return route;
		}
	}
	return "unknown";
}

export function observeProxyFailure(error, request, response) {
	return {
		code: boundedErrorCode(error),
		route: routeCategory(request?.url),
		clientAborted: request?.aborted === true || response?.destroyed === true,
	};
}
