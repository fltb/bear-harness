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
				listenInvalidations(
					receive: (batch: unknown) => void,
					fail: (error: unknown) => void,
				): () => void;
				subscribeLive(
					receive: (batch: unknown) => void,
					fail: (error: unknown) => void,
				): Promise<() => void>;
				invoke(channel: string, request: unknown): Promise<unknown>;
			}>;
		}>;
	}
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

installRendererFaultReporting((fault) => window.bearDesktop.diagnostics.reportRendererFault(fault));

const client: CompanionClient = createCompanionClient({
	listenInvalidations: (receive, fail) =>
		window.bearDesktop.transport.listenInvalidations(receive, fail),
	async subscribeLive(signal) {
		let controller!: ReadableStreamDefaultController<unknown>;
		let stop: () => void = () => {};
		const stream = new ReadableStream<unknown>({
			start(next) {
				controller = next;
			},
		});
		stop = await window.bearDesktop.transport.subscribeLive(
			(batch) => controller.enqueue(batch),
			(error) => {
				stop();
				controller.error(error);
			},
		);
		const abort = () => {
			stop();
			try {
				controller.close();
			} catch {
				// The stream already failed or closed.
			}
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		return stream;
	},
	invoke: <E extends AnyRpcEndpoint>(endpoint: E, request: RequestOf<E>) =>
		window.bearDesktop.transport.invoke(endpoint.channel, request),
});

render(() => <CompanionApp product={productConfig} client={client} />, root);
