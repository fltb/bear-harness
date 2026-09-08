export interface SoakProcessMetrics {
	schemaVersion: 1;
	pid: number;
	uptimeMs: number;
	gcAvailable: boolean;
	eventSubscriptions: number;
	persistenceErrors: number;
	memory: {
		rssBytes: number;
		heapUsedBytes: number;
		heapTotalBytes: number;
	};
}

export function collectSoakProcessMetrics(input: {
	eventSubscriptions: number;
	persistenceErrors: number;
}): SoakProcessMetrics {
	const gcAvailable = typeof globalThis.gc === "function";
	globalThis.gc?.();
	const memory = process.memoryUsage();
	return {
		schemaVersion: 1,
		pid: process.pid,
		uptimeMs: Math.round(process.uptime() * 1000),
		gcAvailable,
		eventSubscriptions: input.eventSubscriptions,
		persistenceErrors: input.persistenceErrors,
		memory: {
			rssBytes: memory.rss,
			heapUsedBytes: memory.heapUsed,
			heapTotalBytes: memory.heapTotal,
		},
	};
}
