/** Stop waiting when an owner retires, without pretending the external work stopped.
 * The underlying promise remains observed; callers must fence its late callbacks.
 */
export function awaitSource<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		void work.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}
