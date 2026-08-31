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
			localFiles: Readonly<{
				pickFiles(): Promise<string[]>;
				pickFolder(): Promise<string[]>;
				pathsForDroppedFiles(files: File[]): string[];
			}>;
			transport: Readonly<{
				listen(
					afterSeq: number,
					receive: (batch: unknown) => void,
					fail: (error: unknown) => void,
				): () => void;
				listenPi(receive: (batch: unknown) => void, fail: (error: unknown) => void): () => void;
				invoke(channel: string, request: unknown): Promise<unknown>;
			}>;
		}>;
	}
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

installRendererFaultReporting((fault) => window.bearDesktop.diagnostics.reportRendererFault(fault));

const client: CompanionClient = createCompanionClient({
	listen: (afterSeq, receive, fail) => window.bearDesktop.transport.listen(afterSeq, receive, fail),
	listenPi: (receive, fail) => window.bearDesktop.transport.listenPi(receive, fail),
	invoke: <E extends AnyRpcEndpoint>(endpoint: E, request: RequestOf<E>) =>
		window.bearDesktop.transport.invoke(endpoint.channel, request),
});

render(() => <CompanionApp product={productConfig} client={client} />, root);
