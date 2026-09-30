import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { registerHostTools } from "../packages/host-runtime/dist/companion/host-tool-register.js";
import { createHostRuntime } from "../packages/host-runtime/dist/runtime.js";
import { LocalEmbeddingService } from "../packages/tdai-core/dist/index.js";

// Run after building Host. Uses an isolated installation and an already acquired
// GGUF; no model credentials, downloads, or relationship-memory capture.
const modelPath = process.env.BEAR_CANON_EMBEDDING_MODEL;
assert(modelPath, "Set BEAR_CANON_EMBEDDING_MODEL to the installed EmbeddingGemma GGUF");
const output = process.env.BEAR_CANON_EMBEDDING_EVIDENCE;
assert(output, "Set BEAR_CANON_EMBEDDING_EVIDENCE to the evidence JSON path");
const sourceFiles = [
	"packages/host-runtime/src/memory/shared-embedding-runtime.ts",
	"packages/host-runtime/src/canon/service.ts",
	"packages/host-runtime/src/character-runtime.ts",
	"packages/host-runtime/src/runtime.ts",
	"packages/tdai-core/src/core/store/embedding.ts",
	"packages/host-runtime/src/memory/tencentdb-runtime.ts",
	"packages/tdai-core/src/core/tdai-core.ts",
	"packages/tdai-core/src/core/store/factory.ts",
	"packages/tdai-core/src/utils/pipeline-factory.ts",
];
const sourceSha256 = Object.fromEntries(
	await Promise.all(
		sourceFiles.map(async (file) => [
			file,
			createHash("sha256")
				.update(await readFile(file))
				.digest("hex"),
		]),
	),
);
const root = await realpath(await mkdtemp(join(tmpdir(), "bear-canon-embedding-live-")));
const createHost = () =>
	createHostRuntime({
		dataDir: root,
		characterSeedRoot: resolve("config/characters"),
		productConfig: { defaultCharacterId: "jizhou" },
		memoryConfig: { extraction: { enabled: false }, pipeline: { enableWarmup: false } },
		credentialVault: {
			securityLevel: "session",
			isEncryptionAvailable: () => false,
			encryptString: (value) => Buffer.from(value),
			decryptString: (value) => value.toString(),
		},
	});
const instances = new Set();
let disposals = 0;
const warmup = LocalEmbeddingService.prototype.startWarmup;
const close = LocalEmbeddingService.prototype.close;
LocalEmbeddingService.prototype.startWarmup = function () {
	instances.add(this);
	return warmup.call(this);
};
LocalEmbeddingService.prototype.close = async function () {
	await close.call(this);
	disposals++;
};
let host = createHost();
try {
	const installed = Reflect.get(host, "localEmbeddingAcquisition").resolveCandidatePath(
		"embeddinggemma",
	);
	await mkdir(dirname(installed), { recursive: true });
	await copyFile(modelPath, installed);
	Reflect.get(host, "appSettings").save({
		memoryVectorService: { enabled: true, provider: "local", localModel: "embeddinggemma" },
	});
	const evidence = await host.useCharacter("jizhou", async (runtime) => {
		assert.equal(runtime.relationshipMemoryEnabled, false);
		const options = Reflect.get(runtime.pi, "options");
		const tool = registerHostTools({
			canon: (query, limit) => options.canon("jizhou", query, limit),
		}).host_canon;
		const probes = [
			{ query: "准备晚饭的屋子和供客人翻阅书籍的地方隔着什么", expected: "白熊客栈" },
			{ query: "准备开摊卖面包的快递员需要攒钱买什么", expected: "客栈周边的人" },
			{ query: "站点最后为什么不再有人轮班", expected: "旧极光站" },
		];
		const results = [];
		for (const probe of probes) {
			const lexical = runtime.canon.search("jizhou", probe.query);
			assert.equal(lexical.length, 0, "Probe must not succeed through lexical matching");
			const response = await tool.execute("semantic-probe", { query: probe.query, limit: 1 });
			assert.equal(response.details.ok, true);
			const hits = response.details.data;
			assert(hits[0]?.sourceName.includes(probe.expected), JSON.stringify({ probe, hits }));
			results.push({ ...probe, lexicalHits: lexical.length, toolResult: response });
		}
		const counts = runtime.db.connection
			.prepare("SELECT count(*) AS chunks, count(embedding) AS embedded FROM canon_chunks")
			.get();
		const vectors = runtime.db.connection
			.prepare("SELECT count(*) AS count FROM canon_chunk_vectors")
			.get();
		assert.equal(counts.chunks, counts.embedded);
		assert.equal(counts.chunks, vectors.count);
		assert(counts.chunks > 0);
		assert.equal(Reflect.get(runtime, "memory"), undefined, "Canon must not start TDAI");
		return {
			capturedAt: new Date().toISOString(),
			provider: "local",
			model: "EmbeddingGemma 300M Q8_0",
			dimensions: 768,
			modelSha256: createHash("sha256")
				.update(await readFile(modelPath))
				.digest("hex"),
			relationshipMemoryEnabled: false,
			tdaiStarted: false,
			counts,
			vectors,
			results,
		};
	});
	await host.close();
	host = createHost();
	const restart = await host.useCharacter("jizhou", async (runtime) => {
		const hits = await runtime.canon.searchHybrid("jizhou", evidence.results[0].query, 1);
		assert(hits[0]?.sourceName.includes(evidence.results[0].expected));
		const counts = runtime.db.connection
			.prepare("SELECT count(*) AS chunks, count(embedding) AS embedded FROM canon_chunks")
			.get();
		assert.deepEqual(counts, evidence.counts);
		assert.equal(Reflect.get(runtime, "memory"), undefined);
		assert.equal(instances.size, 2, "Exactly one model instance per Host lifetime");
		runtime.db.connection.exec("UPDATE character_memory_settings SET enabled=1 WHERE id=1");
		assert.equal(runtime.relationshipMemoryEnabled, true);
		await Promise.all([
			runtime.memoryRuntime.start(),
			runtime.canon.searchHybrid("jizhou", evidence.results[0].query, 1),
		]);
		const embedding = runtime.memoryRuntime.getEmbeddingService();
		assert(embedding);
		assert.equal((await embedding.embed("shared memory probe")).length, 768);
		assert.equal(instances.size, 2, "Starting TDAI must not load another model");
		await runtime.resetMemory();
		assert.equal(disposals, 1, "Closing character memory must not dispose the shared model");
		const afterClose = await runtime.canon.searchHybrid("jizhou", evidence.results[0].query, 1);
		assert(afterClose[0]?.sourceName.includes(evidence.results[0].expected));
		await runtime.memoryRuntime.start();
		assert.equal(instances.size, 2, "Reopening TDAI must reuse the model");
		return {
			counts,
			semanticHit: hits[0].sourceName,
			canonDidNotStartMemory: true,
			sharedModelInstancesInHost: 1,
			memoryEmbeddingDimensions: 768,
			canonWorksAfterMemoryClose: true,
			memoryReopenReusedModel: true,
		};
	});
	await host.close();
	assert.equal(disposals, 2, "Each Host disposes its one shared model exactly once");
	await writeFile(
		output,
		`${JSON.stringify({ ...evidence, sourceSha256, restart, modelInstances: instances.size, modelDisposals: disposals }, null, 2)}\n`,
	);
	console.log(
		JSON.stringify({ evidence: output, counts: evidence.counts, probes: evidence.results.length }),
	);
} finally {
	await host.close();
	LocalEmbeddingService.prototype.startWarmup = warmup;
	LocalEmbeddingService.prototype.close = close;
	await rm(root, { recursive: true, force: true });
}
