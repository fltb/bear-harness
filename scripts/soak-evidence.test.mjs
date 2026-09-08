import assert from "node:assert/strict";
import test from "node:test";
import { validateSoakReport } from "./soak-evidence.mjs";

function passingReport() {
	return {
		schemaVersion: 1,
		mode: "release",
		commit: "0123456789abcdef0123456789abcdef01234567",
		durationMs: 7_200_000,
		counts: {
			cycles: 5_000,
			switches: 1_000,
			stops: 500,
			authoritativeEntries: 10_000,
			historyLoads: 100,
			runArtifactInteractions: 50,
			mediaChoiceInteractions: 50,
		},
		correctness: {
			crossConversationEvents: 0,
			duplicateEntries: 0,
			missingEntries: 0,
			postStopTokens: 0,
			stuckStreams: 0,
			pageErrors: 0,
			unhandledRejections: 0,
			processCrashes: 0,
			ownershipErrors: 0,
			persistenceErrors: 0,
			orphanedResources: 0,
		},
		metrics: {
			rendererHeapSlopeBytesPerTenMinutes: 512 * 1024,
			rendererHeapNetGrowthBytes: 8 * 1024 * 1024,
			hostHeapSlopeBytesPerTenMinutes: 1024 * 1024,
			hostHeapNetGrowthBytes: 16 * 1024 * 1024,
			residentSetNetGrowthBytes: 32 * 1024 * 1024,
			residentSetMonotonicFinalSamples: 0,
			maxRenderedTimelineRows: 80,
			interactionP95Ms: 80,
			conversationSwitchP95Ms: 200,
			stopFeedbackP95Ms: 80,
			streamExitP95Ms: 800,
			cancelConfirmationP95Ms: 2_000,
			maxNonGcLongTaskMs: 150,
			maxNoProgressMs: 20_000,
		},
		samples: {
			resource: 110,
			interaction: 5_000,
			resourceCoverageMs: 7_200_000,
			postWarmupCoverageMs: 6_540_000,
			maxResourceGapMs: 60_000,
		},
		resourceTrace: {
			path: "soak-resource-samples.json",
			size: 3,
			sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
		},
	};
}

test("release soak evidence accepts only a complete passing 120-minute report", () => {
	assert.equal(validateSoakReport(passingReport()).mode, "release");
});

test("release soak evidence rejects short, under-loaded, incorrect, or leaking runs", () => {
	for (const report of [
		{ ...passingReport(), durationMs: 7_199_999 },
		{ ...passingReport(), counts: { ...passingReport().counts, cycles: 4_999 } },
		{
			...passingReport(),
			correctness: { ...passingReport().correctness, crossConversationEvents: 1 },
		},
		{
			...passingReport(),
			metrics: {
				...passingReport().metrics,
				rendererHeapSlopeBytesPerTenMinutes: 1024 * 1024 + 1,
			},
		},
		{
			...passingReport(),
			metrics: { ...passingReport().metrics, residentSetMonotonicFinalSamples: 3 },
		},
		{
			...passingReport(),
			resourceTrace: { ...passingReport().resourceTrace, path: "../outside.json" },
		},
		{
			...passingReport(),
			resourceTrace: { ...passingReport().resourceTrace, sha256: "not-a-digest" },
		},
		{
			...passingReport(),
			samples: { ...passingReport().samples, resourceCoverageMs: 7_199_999 },
		},
		{
			...passingReport(),
			samples: { ...passingReport().samples, maxResourceGapMs: 75_001 },
		},
	]) {
		assert.throws(() => validateSoakReport(report));
	}
});

test("calibration reports enforce correctness and interaction budgets without long-run load slopes", () => {
	const report = passingReport();
	assert.equal(
		validateSoakReport({
			...report,
			mode: "calibration",
			durationMs: 60_000,
			counts: Object.fromEntries(Object.keys(report.counts).map((key) => [key, 1])),
			metrics: {
				...report.metrics,
				rendererHeapSlopeBytesPerTenMinutes: 100 * 1024 * 1024,
				hostHeapSlopeBytesPerTenMinutes: 100 * 1024 * 1024,
				residentSetNetGrowthBytes: 100 * 1024 * 1024,
			},
			samples: {
				resource: 2,
				interaction: 1,
				resourceCoverageMs: 1_000,
				postWarmupCoverageMs: 0,
				maxResourceGapMs: 1_000,
			},
		}).mode,
		"calibration",
	);
});
