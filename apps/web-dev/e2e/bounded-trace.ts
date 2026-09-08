export function appendBoundedTrace<T>(trace: T[], value: T, maximum: number): void {
	if (!Number.isSafeInteger(maximum) || maximum < 1) {
		throw new Error("trace maximum must be a positive integer");
	}
	trace.push(value);
	if (trace.length > maximum) trace.splice(0, trace.length - maximum);
}
