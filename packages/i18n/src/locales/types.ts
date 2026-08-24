/**
 * Preserves catalog keys and nesting while allowing each locale's own strings.
 * The Simplified Chinese catalog is the canonical application-copy schema.
 */
export type LocalizedCatalog<T> = {
	readonly [Key in keyof T]: T[Key] extends string
		? string
		: T[Key] extends readonly (infer Item)[]
			? readonly LocalizedValue<Item>[]
			: T[Key] extends object
				? LocalizedCatalog<T[Key]>
				: never;
};

type LocalizedValue<T> = T extends string ? string : T extends object ? LocalizedCatalog<T> : never;
