import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const forbidden = String.fromCodePoint(0x4e0d);
export async function checkCopy() {
	const failures = [];
	async function scan(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) await scan(path);
			else if (/\.(json|tsx?|html)$/.test(entry.name)) {
				const lines = (await readFile(path, "utf8")).split("\n");
				lines.forEach((line, index) => {
					const approvedQuestion =
						path === resolve(root, "src/demo/scenario.json") &&
						line.trim() === '"user": "你是不是每件都想留下？",';
					if (line.includes(forbidden) && !approvedQuestion) failures.push(`${path}:${index + 1}`);
				});
			}
		}
	}
	await scan(resolve(root, "src"));
	if (failures.length)
		throw new Error(`Promo copy contains forbidden U+4E0D:\n${failures.join("\n")}`);
	console.log("Promo copy check passed");
}

await checkCopy();
