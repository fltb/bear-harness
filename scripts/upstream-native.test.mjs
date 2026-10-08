import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { LocalEmbeddingService } from "../packages/tdai-core/dist/core/store/embedding.js";
import { nativeCapabilities } from "../packages/tdai-core/dist/native/capabilities.js";

const modelHash = "6fa0c02a9c302be6f977521d399b4de3a46310a4f2621ee0063747881b673f67";
const cache = resolve(".cache/upstream");
let service;
let directory;
async function sha256(path) {
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(path)) digest.update(chunk);
	return digest.digest("hex");
}
before(
	async () => {
		directory = await mkdtemp(join(tmpdir(), "bear-native-contract-"));
		await mkdir(cache, { recursive: true });
		let path = process.env.BEAR_UPSTREAM_MODEL ?? join(cache, "embeddinggemma-300m-qat-Q8_0.gguf");
		try {
			await access(path);
		} catch (error) {
			if (error.code !== "ENOENT" || process.env.BEAR_UPSTREAM_MODEL) throw error;
			const llama = await nativeCapabilities.importLlama();
			path = await llama.resolveModelFile(
				"hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf",
				{ directory: cache, download: "auto", cli: false },
			);
		}
		assert.equal(await sha256(path), modelHash, "Embedding fixture integrity");
		service = new LocalEmbeddingService({
			provider: "local",
			modelPath: path,
			download: false,
			dimensions: 768,
		});
		service.startWarmup();
		await service.waitForReady();
	},
	{ timeout: 600_000 },
);
after(async () => {
	await service?.close();
	if (directory) await rm(directory, { recursive: true, force: true });
});

test("native: loads a real GGUF and returns normalized finite vectors", async () => {
	const vector = await service.embed("A quiet library full of books");
	assert.equal(vector.length, 768);
	assert(vector.every(Number.isFinite));
	assert(Math.abs(Math.hypot(...vector) - 1) < 0.001);
});
test("native: batch embeddings preserve input count and semantic order", async () => {
	const vectors = await service.embedBatch([
		"A library full of books",
		"Reading books in a library",
		"Repairing a car engine",
	]);
	assert.equal(vectors.length, 3);
	const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
	assert(dot(vectors[0], vectors[1]) > dot(vectors[0], vectors[2]));
});
test("native: sqlite-vec indexes, ranks and reloads vectors", () => {
	const path = join(directory, "vectors.db");
	const db = new DatabaseSync(path, { allowExtension: true });
	try {
		nativeCapabilities.loadSqliteVec().load(db);
		db.exec("CREATE VIRTUAL TABLE vectors USING vec0(embedding float[3])");
		const insert = db.prepare("INSERT INTO vectors(rowid,embedding) VALUES (?,?)");
		insert.run(1n, new Float32Array([1, 0, 0]));
		insert.run(2n, new Float32Array([0, 1, 0]));
		const rows = db
			.prepare(
				"SELECT rowid,distance FROM vectors WHERE embedding MATCH ? AND k=2 ORDER BY distance",
			)
			.all(new Float32Array([1, 0, 0]));
		assert.equal(rows[0].rowid, 1);
		assert.equal(rows[0].distance, 0);
	} finally {
		db.close();
	}
	const reopened = new DatabaseSync(path, { allowExtension: true });
	try {
		nativeCapabilities.loadSqliteVec().load(reopened);
		assert.equal(reopened.prepare("SELECT count(*) AS n FROM vectors").get().n, 2);
	} finally {
		reopened.close();
	}
});
test("native: Jieba loads its real dictionary and segments Chinese", () => {
	const jieba = nativeCapabilities.getJieba();
	assert(jieba, "Native Jieba must load");
	const terms = jieba.cutForSearch("我在图书馆阅读书籍", true);
	assert(terms.includes("图书馆"));
	assert(terms.includes("阅读"));
});
test("native: closes model resources and permits a fresh service", async () => {
	await service.close();
	assert.equal(service.isReady(), false);
	service.startWarmup();
	await service.waitForReady();
	assert.equal((await service.embed("再见")).length, 768);
});
