import { i18n, useTranslation } from "@bear-harness/i18n";
import { Root as Link } from "@kobalte/core/link";

const AUTHORING_GUIDE =
	"https://github.com/fltb/bear-harness/blob/main/docs/character-package-authoring.md";

export function CharacterPackageWorkshop() {
	const [t] = useTranslation(undefined, { i18n });
	return (
		<section class="character-package-guide">
			<h3>{t("packageWorkshop.title")}</h3>
			<p class="drawer-note">{t("packageWorkshop.disabledNote")}</p>
			<p class="drawer-note">{t("packageWorkshop.toolRecommendation")}</p>
			<Link class="button-like" href={AUTHORING_GUIDE} target="_blank" rel="noreferrer">
				{t("packageWorkshop.openGuide")}
				<span aria-hidden="true">↗</span>
			</Link>
		</section>
	);
}
