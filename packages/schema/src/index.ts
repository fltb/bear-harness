import { z } from "zod";

export { z };
export type Schema = z.ZodType;
export type Infer<T extends Schema> = z.infer<T>;

export function toJsonSchema(schema: Schema): Record<string, unknown> {
	return z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
}
