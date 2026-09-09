export function normalizeArchivePath(value) {
	const normalized = value.split("\\").join("/");
	return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
