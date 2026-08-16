import { screen } from "@solidjs/testing-library";

interface PointerUser {
	click(element: Element): Promise<void>;
}

export async function selectKobalteOption(
	user: PointerUser,
	trigger: Element,
	value: string | { label: string },
): Promise<void> {
	await user.click(trigger);
	const options = await screen.findAllByRole("option");
	const expected = typeof value === "string" ? value : value.label;
	const option = options.find(
		(candidate) =>
			candidate.getAttribute("data-key") === expected || candidate.textContent?.trim() === expected,
	);
	if (!option) throw new Error(`Kobalte option not found: ${expected}`);
	await user.click(option);
}
