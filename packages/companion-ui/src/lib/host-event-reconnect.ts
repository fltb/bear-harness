/** Connection retry only; never a timer for reading application state. */
export function waitForEventReconnect(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, 1000);
		signal.addEventListener("abort", done, { once: true });
	});
}
