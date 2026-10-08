// Shared by workflow validation, evidence verification and automatic merging.
// null means the job is checked through Actions, without a separate stage record.
export const CI_JOB_STAGES = Object.freeze({
	preflight: "preflight",
	quality: "quality",
	"upstream-brand": null,
	security: null,
	recovery: "recovery",
	e2e: "electron-e2e",
	"web-e2e": "web-e2e",
	package: null,
	"release-gate": null,
});
export const REQUIRED_CI_JOBS = Object.freeze(Object.keys(CI_JOB_STAGES));
export const REQUIRED_STAGE_ATTESTATIONS = Object.freeze(
	Object.values(CI_JOB_STAGES).filter(Boolean),
);
