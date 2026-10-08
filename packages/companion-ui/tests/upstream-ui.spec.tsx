import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { QueryClient } from "@tanstack/solid-query";
import { createSignal, onCleanup } from "solid-js";
import { describe, expect, it } from "vitest";
import { createRpcQuery } from "../src/stores/rpc-query.js";
import { Checkbox, Dialog, Tabs, TextField } from "../src/ui/primitives.js";

describe("upstream: reactive queries", () => {
	it("changes the observed query when the conversation changes", async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const [id, setId] = createSignal("a");
		const view = render(() => {
			const query = createRpcQuery({
				client,
				key: () => ["session", id()],
				request: async (key) => `reply ${key[1]}`,
			});
			return <output aria-label="contract reply">{query.data}</output>;
		});
		await waitFor(() => expect(view.getByLabelText("contract reply")).toHaveTextContent("reply a"));
		setId("b");
		await waitFor(() => expect(view.getByLabelText("contract reply")).toHaveTextContent("reply b"));
		expect(client.getQueryData(["session", "a"])).toBe("reply a");
		view.unmount();
		client.clear();
	});
	it("keeps two character query caches independent", async () => {
		const a = new QueryClient();
		const b = new QueryClient();
		await a.fetchQuery({ queryKey: ["state"], queryFn: async () => "character a" });
		await b.fetchQuery({ queryKey: ["state"], queryFn: async () => "character b" });
		await a.invalidateQueries({ queryKey: ["state"] });
		expect(b.getQueryData(["state"])).toBe("character b");
		expect(b.getQueryState(["state"])?.isInvalidated).toBe(false);
		a.clear();
		b.clear();
	});
	it("cancels the actual query function through its signal", async () => {
		const client = new QueryClient();
		const entered = Promise.withResolvers<void>();
		let aborted = false;
		const request = client.fetchQuery({
			queryKey: ["pending"],
			queryFn: ({ signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(signal.reason);
						},
						{ once: true },
					);
					entered.resolve();
				}),
		});
		const rejected = expect(request).rejects.toThrow();
		await entered.promise;
		await client.cancelQueries({ queryKey: ["pending"] });
		await rejected;
		expect(aborted).toBe(true);
		client.clear();
	});
	it("updates Solid props and runs cleanup on unmount", () => {
		const [text, setText] = createSignal("first");
		let disposed = false;
		const view = render(() => {
			onCleanup(() => {
				disposed = true;
			});
			return <output aria-label="reactive contract">{text()}</output>;
		});
		setText("second");
		expect(view.getByLabelText("reactive contract")).toHaveTextContent("second");
		view.unmount();
		expect(disposed).toBe(true);
	});
});

describe("upstream: real Kobalte primitives", () => {
	it("opens and closes a modal through its controls", async () => {
		const view = render(() => (
			<Dialog>
				<Dialog.Trigger>contract open</Dialog.Trigger>
				<Dialog.Portal>
					<Dialog.Overlay />
					<Dialog.Content>
						<Dialog.Title>contract modal</Dialog.Title>
						<Dialog.Description>contract description</Dialog.Description>
						<Dialog.CloseButton aria-label="contract close">contract close</Dialog.CloseButton>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog>
		));
		fireEvent.click(view.getByRole("button", { name: "contract open" }));
		expect(await screen.findByRole("dialog", { name: "contract modal" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "contract close" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		view.unmount();
	});
	it("propagates controlled checkbox changes", () => {
		const [checked, setChecked] = createSignal(false);
		const view = render(() => (
			<Checkbox checked={checked()} onChange={setChecked}>
				<Checkbox.Input />
				<Checkbox.Label>contract checkbox</Checkbox.Label>
			</Checkbox>
		));
		fireEvent.click(view.getByRole("checkbox", { name: "contract checkbox" }));
		expect(checked()).toBe(true);
		expect(view.getByRole("checkbox")).toBeChecked();
		view.unmount();
	});
	it("propagates controlled text field input", () => {
		const [value, setValue] = createSignal("before");
		const view = render(() => (
			<TextField value={value()} onChange={setValue}>
				<TextField.Label>contract input</TextField.Label>
				<TextField.Input />
			</TextField>
		));
		fireEvent.input(view.getByRole("textbox", { name: "contract input" }), {
			target: { value: "after" },
		});
		expect(value()).toBe("after");
		view.unmount();
	});
	it("selects a tab with the keyboard and exposes its panel", async () => {
		const view = render(() => (
			<Tabs defaultValue="a">
				<Tabs.List>
					<Tabs.Trigger value="a">contract first</Tabs.Trigger>
					<Tabs.Trigger value="b">contract second</Tabs.Trigger>
				</Tabs.List>
				<Tabs.Content value="a">panel a</Tabs.Content>
				<Tabs.Content value="b">panel b</Tabs.Content>
			</Tabs>
		));
		const first = view.getByRole("tab", { name: "contract first" });
		first.focus();
		fireEvent.keyDown(first, { key: "ArrowRight" });
		await waitFor(() =>
			expect(view.getByRole("tab", { name: "contract second" })).toHaveAttribute(
				"aria-selected",
				"true",
			),
		);
		expect(view.getByRole("tabpanel")).toHaveTextContent("panel b");
		view.unmount();
	});
});
