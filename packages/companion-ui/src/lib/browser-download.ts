/** Release only the browser capability; this timer does not poll product state. */
export function downloadBlob(blob: Blob, fileName: string): void {
	const url = URL.createObjectURL(blob);
	try {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = fileName.split(/[\\/]/).pop() || "download";
		anchor.rel = "noopener";
		document.body.append(anchor);
		anchor.click();
		anchor.remove();
	} finally {
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
}
