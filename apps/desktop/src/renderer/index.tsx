import type { CompanionClient } from "@bear-harness/companion-types";
import { CompanionApp, installRendererFaultReporting } from "@bear-harness/companion-ui";
import { productConfig } from "@bear-harness/product-config";
import { render } from "solid-js/web";
import "@bear-harness/companion-ui/styles.css";

declare global {
	interface Window {
		bearDesktop: Readonly<{
			platform: "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32";
			diagnostics: Readonly<{
				reportRendererFault(input: unknown): void;
			}>;
			companion: CompanionClient;
		}>;
	}
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

installRendererFaultReporting((fault) => window.bearDesktop.diagnostics.reportRendererFault(fault));

render(() => <CompanionApp product={productConfig} client={window.bearDesktop.companion} />, root);
