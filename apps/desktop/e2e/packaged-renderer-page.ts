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
		let timer: ReturnType<typeof setTimeout>;
		const cleanup = () => {
			clearTimeout(timer);
			context.off("page", onPage);
		};
		const accept = (page: Page) => {
			cleanup();
			resolve(page);
		};
		const onPage = (page: Page) => {
			if (isPackagedRenderer(page)) accept(page);
		};
		context.on("page", onPage);
		timer = setTimeout(() => {
			cleanup();
			reject(new Error("packaged app did not create a file renderer"));
		}, timeoutMs);
		const afterSubscription = context.pages().find(isPackagedRenderer);
		if (afterSubscription) accept(afterSubscription);
	});
}
