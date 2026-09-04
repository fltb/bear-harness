import { type Accessor, createEffect } from "solid-js";

/** The only reactive effects in the renderer: write browser DOM, never application state. */
export function syncDocumentTitle(title: Accessor<string>): void {
	createEffect(() => {
		document.title = title();
	});
}
