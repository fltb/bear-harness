import assert from "node:assert/strict";
import test from "node:test";
import { collectSoakProcessMetrics } from "./soak-metrics.ts";

test("soak process metrics expose bounded numeric process facts without content", () => {
	const metrics = collectSoakProcessMetrics({ eventSubscriptions: 2, persistenceErrors: 0 });
	assert.equal(metrics.schemaVersion, 1);
	assert.equal(metrics.eventSubscriptions, 2);
	assert.equal(metrics.persistenceErrors, 0);
	assert.equal(typeof metrics.gcAvailable, "boolean");
	assert.ok(Number.isSafeInteger(metrics.pid));
	assert.ok(metrics.memory.rssBytes > 0);
	assert.ok(metrics.memory.heapUsedBytes > 0);
	assert.ok(metrics.memory.heapTotalBytes >= metrics.memory.heapUsedBytes);
	assert.deepEqual(Object.keys(metrics).sort(), [
		"eventSubscriptions",
		"gcAvailable",
		"memory",
		"persistenceErrors",
		"pid",
		"schemaVersion",
		"uptimeMs",
	]);
});
