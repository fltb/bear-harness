export function trackApi<T extends object>(
	name: string,
	api: T,
	onError: (operation: string, cause: unknown) => void,
): T {
	return new Proxy(api, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				try {
					const result = value.apply(target, args);
					return typeof result?.then === "function"
						? result.catch((cause: unknown) => {
								onError(`${name}.${String(property)}`, cause);
								throw cause;
							})
						: result;
				} catch (cause) {
					onError(`${name}.${String(property)}`, cause);
					throw cause;
				}
			};
		},
	});
}
