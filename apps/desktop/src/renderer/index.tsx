import type { CompanionClient } from "@bear-harness/companion-client";
import { createCompanionClient } from "@bear-harness/companion-client";
import { CompanionApp, installRendererFaultReporting } from "@bear-harness/companion-ui";
import { productConfig } from "@bear-harness/product-config";
import type { AnyRpcEndpoint, RequestOf } from "@bear-harness/protocol";
import { render } from "solid-js/web";
import "@bear-harness/companion-ui/styles.css";

declare global {
	interface Window {
		bearDesktop: Readonly<{
			platform: "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32";
			diagnostics: Readonly<{
				reportRendererFault(input: unknown): void;
			}>;
			transport: Readonly<{
				invoke(channel: string, request: unknown): Promise<unknown>;
			}>;
			resources: Readonly<{
				pickFiles(conversationId: string): Promise<unknown>;
				pickDirectory(conversationId: string): Promise<unknown>;
				attachDropped(conversationId: string, files: readonly File[]): Promise<unknown>;
				detach(conversationId: string, resourceId: string): Promise<unknown>;
			}>;
		}>;
	}
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

installRendererFaultReporting((fault) => window.bearDesktop.diagnostics.reportRendererFault(fault));

const client: CompanionClient = createCompanionClient({
	invoke: <E extends AnyRpcEndpoint>(endpoint: E, request: RequestOf<E>) =>
		window.bearDesktop.transport.invoke(endpoint.channel, request),
});

render(() => <CompanionApp product={productConfig} client={client} />, root);
