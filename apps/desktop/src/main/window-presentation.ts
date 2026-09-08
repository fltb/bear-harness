export type WindowPresentation = "hidden" | "inactive" | "active";

export function windowPresentation(input: {
	sourceE2E: boolean;
	packagedE2E: boolean;
	ci: boolean;
}): WindowPresentation {
	if (input.sourceE2E || input.packagedE2E) return input.ci ? "hidden" : "inactive";
	return "active";
}
