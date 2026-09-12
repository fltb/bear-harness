export async function entriesAfterLeaf(snapshot, beforeLeafId, readHistory) {
	let visible = snapshot.branch.entries;
	if (!beforeLeafId) return visible;
	const cursors = new Set();
	for (;;) {
		const index = visible.findIndex((entry) => entry.id === beforeLeafId);
		if (index >= 0) return visible.slice(index + 1);
		const first = visible[0];
		if (first?.parentId === beforeLeafId) return visible;
		if (!first || cursors.has(first.id))
			throw new Error("Native history did not reach the previous leaf");
		cursors.add(first.id);
		const page = await readHistory(first.id);
		if (!page.entries.length)
			throw new Error("Previous native leaf is absent from the conversation branch");
		visible = [...page.entries, ...visible];
	}
}
