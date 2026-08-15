import { createCompanionClient } from "@bear-harness/companion-client";
import { CompanionApp, installRendererFaultReporting } from "@bear-harness/companion-ui";
import { Show } from "solid-js";
import { render } from "solid-js/web";
import "@bear-harness/companion-ui/styles.css";
import { WebDevDebugPanel } from "./DebugPanel";
import { createHttpTransport, loadBootstrap } from "./http-client";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

const bootstrap = await loadBootstrap();
const transport = createHttpTransport(bootstrap.token);
const client = createCompanionClient(transport);

installRendererFaultReporting((fault) => {
	void fetch("/diagnostics/renderer-fault", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-bear-web-dev-token": bootstrap.token,
		},
		body: JSON.stringify(fault),
	});
});

render(
	() => (
		<>
			<CompanionApp product={bootstrap.product} client={client} />
			<Show when={bootstrap.debugEnabled}>
				<WebDevDebugPanel client={client} transport={transport} token={bootstrap.token} />
			</Show>
		</>
	),
	root,
);
