export interface RendererObservation {
	conversationId: string;
	event: "received" | "projected" | "scroll" | "fault";
	at: string;
	durationMs?: number;
	sequence?: number;
	distance?: number;
	error?: { name: string; message: string; stack?: string };
}

/** Diagnostic measurements only: bounded metadata, never conversation content. */
export function createRendererDiagnostics(
	send: (records: RendererObservation[]) => Promise<unknown>,
) {
	let records: RendererObservation[] = [];
	let recent: RendererObservation[] = [];
	let inFlight = false;
	let disposed = false;
	let dropped = 0;
	let owner: string | undefined;
	let requested = false;
	const flush = async () => {
		if (disposed || !records.length) return;
		if (inFlight) {
			requested = true;
			return;
		}
		requested = false;
		inFlight = true;
		const batch = records;
		records = [];
		try {
			await send(batch);
		} catch {
			dropped += batch.length;
		} finally {
			inFlight = false;
			if (requested) void flush();
		}
	};
	return {
		scope(next: string | undefined) {
			if (owner === next) return;
			owner = next;
			records = [];
			recent = [];
		},
		record(record: RendererObservation, boundary = false) {
			if (disposed) return;
			if (
				record.error &&
				(record.error.name.length > 128 ||
					record.error.message.length > 65536 ||
					(record.error.stack?.length ?? 0) > 65536)
			) {
				dropped++;
				return;
			}
			if (record.event === "fault") records = recent.slice(-127);
			recent.push(record);
			if (recent.length > 128) recent.shift();
			if (records.length === 128) {
				records.shift();
				dropped++;
			}
			records.push(record);
			if (boundary || records.length >= 32) void flush();
		},
		flush,
		health: () => ({ dropped, buffered: records.length }),
		dispose() {
			disposed = true;
			records = [];
			recent = [];
		},
	};
}
