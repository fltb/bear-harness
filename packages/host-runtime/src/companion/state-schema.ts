import { z } from "@bear-harness/schema";

const StatePath = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u);
const StateValue = z.union([z.string().max(4096), z.number().finite(), z.boolean()]);
export type CharacterStateValue = z.infer<typeof StateValue>;

export const StateOperationName = z.enum([
	"set",
	"increment",
	"decrement",
	"append_unique",
	"remove_value",
	"clear",
]);
export type StateOperationName = z.infer<typeof StateOperationName>;

const StateField = z
	.strictObject({
		type: z.enum(["number", "boolean", "enum", "string", "string_list"]),
		scope: z.enum(["conversation", "relationship", "character"]),
		initial: z.union([StateValue, z.array(z.string().max(4096)).max(100)]),
		model_readable: z.boolean().default(true),
		model_writable: z.boolean().default(false),
		operations: z.array(StateOperationName).max(6).default([]),
		minimum: z.number().finite().optional(),
		maximum: z.number().finite().optional(),
		max_change_per_turn: z.number().finite().positive().optional(),
		values: z.array(z.string().min(1).max(128)).min(1).max(100).optional(),
		allowed_transitions: z
			.array(z.tuple([StateValue, StateValue]))
			.max(100)
			.optional(),
		user_visible: z.boolean().default(false),
		label: z.string().min(1).max(256).optional(),
	})
	.superRefine((field, context) => {
		const initialType = Array.isArray(field.initial) ? "string_list" : typeof field.initial;
		const expected = field.type === "enum" || field.type === "string" ? "string" : field.type;
		if (initialType !== expected)
			context.addIssue({ code: "custom", path: ["initial"], message: "initial type mismatch" });
		if (field.type === "enum" && !field.values?.includes(String(field.initial)))
			context.addIssue({
				code: "custom",
				path: ["initial"],
				message: "enum initial is not allowed",
			});
		if (field.model_writable && field.operations.length === 0)
			context.addIssue({
				code: "custom",
				path: ["operations"],
				message: "writable field needs operations",
			});
		if (!field.model_writable && field.operations.length > 0)
			context.addIssue({
				code: "custom",
				path: ["operations"],
				message: "read-only field cannot allow operations",
			});
		if ((field.minimum !== undefined || field.maximum !== undefined) && field.type !== "number")
			context.addIssue({
				code: "custom",
				path: ["minimum"],
				message: "bounds require number type",
			});
		if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum)
			context.addIssue({ code: "custom", path: ["minimum"], message: "minimum exceeds maximum" });
	});

export const CharacterStateSchema = z
	.strictObject({
		version: z.number().int().min(1).max(1).default(1),
		fields: z.record(StatePath, StateField).default({}),
	})
	.superRefine((schema, context) => {
		if (Object.keys(schema.fields).length > 200)
			context.addIssue({ code: "custom", path: ["fields"], message: "too many state fields" });
	});

export type CharacterStateDefinition = z.infer<typeof CharacterStateSchema>;
export type CharacterStateField = CharacterStateDefinition["fields"][string];

export const CharacterStateOperation = z.strictObject({
	path: StatePath,
	op: StateOperationName,
	value: z.union([StateValue, z.array(z.string().max(4096)).max(100)]).optional(),
});
export type CharacterStateOperation = z.infer<typeof CharacterStateOperation>;
