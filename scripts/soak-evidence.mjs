const MIB = 1024 * 1024;

export const SOAK_REPORT_SCHEMA_VERSION = 1;
export const RELEASE_SOAK_MINIMUM_DURATION_MS = 120 * 60 * 1000;

const COUNT_KEYS = [
	"cycles",
	"switches",
	"stops",
	"authoritativeEntries",
	"historyLoads",
	"runArtifactInteractions",
	"mediaChoiceInteractions",
];
const RELEASE_COUNT_MINIMUMS = {
	cycles: 5_000,
	switches: 1_000,
	stops: 500,
	authoritativeEntries: 10_000,
	historyLoads: 100,
	runArtifactInteractions: 50,
	mediaChoiceInteractions: 50,
};
const CORRECTNESS_KEYS = [
	"crossConversationEvents",
	"duplicateEntries",
	"missingEntries",
	"postStopTokens",
	"stuckStreams",
	"pageErrors",
	"unhandledRejections",
	"processCrashes",
	"ownershipErrors",
	"persistenceErrors",
	"orphanedResources",
];
const METRIC_MAXIMUMS = {
	rendererHeapSlopeBytesPerTenMinutes: MIB,
	rendererHeapNetGrowthBytes: 12 * MIB,
	hostHeapSlopeBytesPerTenMinutes: 2 * MIB,
	hostHeapNetGrowthBytes: 24 * MIB,
	residentSetNetGrowthBytes: 64 * MIB,
	residentSetMonotonicFinalSamples: 2,
	maxRenderedTimelineRows: 100,
	interactionP95Ms: 100,
	conversationSwitchP95Ms: 250,
	stopFeedbackP95Ms: 100,
	streamExitP95Ms: 1_000,
	cancelConfirmationP95Ms: 3_000,
	maxNonGcLongTaskMs: 200,
	maxNoProgressMs: 30_000,
};

function plainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
	if (!plainObject(value)) throw new Error(`${label} must be an object`);
	const actual = Object.keys(value);
	if (actual.length !== expected.length || !expected.every((key) => actual.includes(key))) {
		throw new Error(`${label} has an invalid shape`);
	}
	return value;
}

function nonNegativeNumber(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a finite non-negative number`);
	}
	return value;
}

function validHexadecimal(value, length) {
	if (typeof value !== "string" || value.length !== length) return false;
	const hexadecimal = "0123456789abcdef";
	return [...value].every((character) => hexadecimal.includes(character));
}

function validCommit(value) {
	return validHexadecimal(value, 40);
}

export function validateSoakReport(input) {
	const report = exactKeys(
		input,
		[
			"schemaVersion",
			"mode",
			"commit",
			"durationMs",
			"counts",
			"correctness",
			"metrics",
			"samples",
			"resourceTrace",
		],
		"soak report",
	);
	if (report.schemaVersion !== SOAK_REPORT_SCHEMA_VERSION) {
		throw new Error("soak report must use schema version 1");
	}
	if (report.mode !== "release" && report.mode !== "calibration") {
		throw new Error("soak report mode must be release or calibration");
	}
	if (!validCommit(report.commit)) throw new Error("soak report commit is invalid");
	const durationMs = nonNegativeNumber(report.durationMs, "soak duration");
	if (durationMs <= 0) throw new Error("soak duration must be positive");
	if (report.mode === "release" && durationMs < RELEASE_SOAK_MINIMUM_DURATION_MS) {
		throw new Error("release soak must run for at least 120 minutes");
	}

	const counts = exactKeys(report.counts, COUNT_KEYS, "soak counts");
	for (const key of COUNT_KEYS) {
		const value = nonNegativeNumber(counts[key], `soak count ${key}`);
		if (!Number.isSafeInteger(value)) throw new Error(`soak count ${key} must be an integer`);
		if (report.mode === "release" && value < RELEASE_COUNT_MINIMUMS[key]) {
			throw new Error(`release soak count ${key} is below its minimum`);
		}
	}

	const correctness = exactKeys(report.correctness, CORRECTNESS_KEYS, "soak correctness");
	for (const key of CORRECTNESS_KEYS) {
		if (correctness[key] !== 0) throw new Error(`soak correctness ${key} must be zero`);
	}

	const metrics = exactKeys(report.metrics, Object.keys(METRIC_MAXIMUMS), "soak metrics");
	for (const [key, maximum] of Object.entries(METRIC_MAXIMUMS)) {
		const value = nonNegativeNumber(metrics[key], `soak metric ${key}`);
		const longRunMetric = [
			"rendererHeapSlopeBytesPerTenMinutes",
			"rendererHeapNetGrowthBytes",
			"hostHeapSlopeBytesPerTenMinutes",
			"hostHeapNetGrowthBytes",
			"residentSetNetGrowthBytes",
			"residentSetMonotonicFinalSamples",
		].includes(key);
		if ((report.mode === "release" || !longRunMetric) && value > maximum) {
			throw new Error(`soak metric ${key} exceeds its budget`);
		}
	}

	const samples = exactKeys(report.samples, ["resource", "interaction"], "soak samples");
	for (const key of ["resource", "interaction"]) {
		const value = nonNegativeNumber(samples[key], `soak samples ${key}`);
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new Error(`soak samples ${key} must be a positive integer`);
		}
	}
	if (report.mode === "release" && samples.resource < 111) {
		throw new Error("release soak requires at least 111 post-warmup resource samples");
	}
	const resourceTrace = exactKeys(
		report.resourceTrace,
		["path", "size", "sha256"],
		"soak resource trace",
	);
	if (resourceTrace.path !== "soak-resource-samples.json") {
		throw new Error("soak resource trace path is invalid");
	}
	if (!Number.isSafeInteger(resourceTrace.size) || resourceTrace.size <= 0) {
		throw new Error("soak resource trace size is invalid");
	}
	if (!validHexadecimal(resourceTrace.sha256, 64)) {
		throw new Error("soak resource trace digest is invalid");
	}
	return report;
}
