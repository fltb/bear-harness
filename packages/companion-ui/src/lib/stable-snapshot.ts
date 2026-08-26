import { type Accessor, createMemo } from "solid-js";
/** JSON protocol DTOs retain identity across equal Host snapshots. */
export function createStableSnapshot<T>(read: Accessor<T>): Accessor<T> {
	return createMemo(read, undefined, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
}
