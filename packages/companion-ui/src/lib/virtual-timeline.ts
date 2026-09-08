export function reconcileVirtualTimelineMeasurements<
	Measurement extends { key: string | number | bigint; index: number },
	Item extends { id: string },
>(measurements: readonly Measurement[], items: readonly Item[]) {
	const currentIds = new Set(items.map((item) => item.id));
	const reconciled = new Map<string, Measurement>();
	for (const measurement of measurements) {
		const measuredKey = String(measurement.key);
		const key = currentIds.has(measuredKey) ? measuredKey : items[measurement.index]?.id;
		if (key !== undefined && !reconciled.has(key)) reconciled.set(key, measurement);
	}
	return reconciled;
}
