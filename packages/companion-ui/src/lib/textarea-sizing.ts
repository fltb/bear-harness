export function fitTextareaToContent(textarea: HTMLTextAreaElement): void {
	textarea.style.height = "auto";
	textarea.style.height = `${textarea.scrollHeight}px`;
	textarea.style.overflowY = textarea.scrollHeight > textarea.clientHeight ? "auto" : "hidden";
}
