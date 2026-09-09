type PackagedPage = {
	url(): string;
};

type PackagedContext<Page extends PackagedPage> = {
	pages(): Page[];
	on(event: "page", listener: (page: Page) => void): unknown;
	off(event: "page", listener: (page: Page) => void): unknown;
};

const isPackagedRenderer = (page: PackagedPage) => page.url().startsWith("file://");

export function waitForPackagedRendererPage<Page extends PackagedPage>(
	context: PackagedContext<Page>,
	timeoutMs: number,
): Promise<Page> {
	const current = context.pages().find(isPackagedRenderer);
	if (current) return Promise.resolve(current);
	return new Promise((resolve, reject) => {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let poll: ReturnType<typeof setInterval> | undefined;
		let settled = false;
		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			if (poll) clearInterval(poll);
			context.off("page", onPage);
		};
		const accept = (page: Page) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(page);
		};
		const onPage = (page: Page) => {
			if (isPackagedRenderer(page)) accept(page);
		};
		context.on("page", onPage);
		poll = setInterval(() => {
			const renderer = context.pages().find(isPackagedRenderer);
			if (renderer) accept(renderer);
		}, 10);
		timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error("packaged app did not create a file renderer"));
		}, timeoutMs);
		const afterSubscription = context.pages().find(isPackagedRenderer);
		if (afterSubscription) accept(afterSubscription);
	});
}
