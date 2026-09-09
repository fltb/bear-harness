export type WindowPresentation = "inactive" | "active";

export function windowPresentation(input: {
	sourceE2E: boolean;
	packagedE2E: boolean;
}): WindowPresentation {
	if (input.sourceE2E || input.packagedE2E) return "inactive";
	return "active";
}
