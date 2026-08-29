import { z } from "@bear-harness/schema";

const StatePath = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u);
const StateValue = z.union([z.string().max(4096), z.number().finite(), z.boolean()]);
export type CharacterStateValue = z.infer<typeof StateValue>;

export const StateWriteAuthority = z.union([
	z.literal("model"),
	z.literal("host_event"),
	z.literal("user_choice"),
	z.literal("readonly"),
	z.string().regex(/^skill:[a-z][a-z0-9-]{0,63}$/u),
]);
export type StateWriteAuthority = z.infer<typeof StateWriteAuthority>;

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
		write_authority: StateWriteAuthority,
		deterministic_authorities: z
			.array(z.enum(["host_event", "user_choice"]))
			.max(2)
			.default([]),
		operations: z.array(StateOperationName).max(6).default([]),
		description: z.string().min(1).max(2000),
		value_meanings: z.record(z.string().min(1).max(128), z.string().min(1).max(1000)).default({}),
		update_when: z.array(z.string().min(1).max(1000)).max(30).default([]),
		do_not_update_when: z.array(z.string().min(1).max(1000)).max(30).default([]),
		evidence_required: z.boolean().default(false),
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
		if (field.write_authority !== "readonly" && field.operations.length === 0)
			context.addIssue({
				code: "custom",
				path: ["operations"],
				message: "writable field needs operations",
			});
		if (field.write_authority === "readonly" && field.operations.length > 0)
			context.addIssue({
				code: "custom",
				path: ["operations"],
				message: "read-only field cannot allow operations",
			});
		if (field.write_authority === "readonly" && field.deterministic_authorities.length > 0)
			context.addIssue({
				code: "custom",
				path: ["deterministic_authorities"],
				message: "read-only field cannot allow deterministic event writes",
			});
		if ((field.minimum !== undefined || field.maximum !== undefined) && field.type !== "number")
			context.addIssue({
				code: "custom",
				path: ["minimum"],
				message: "bounds require number type",
			});
		if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum)
			context.addIssue({ code: "custom", path: ["minimum"], message: "minimum exceeds maximum" });
		if (
			(field.write_authority === "model" || field.write_authority.startsWith("skill:")) &&
			(field.update_when.length === 0 || field.do_not_update_when.length === 0)
		)
			context.addIssue({
				code: "custom",
				path: ["update_when"],
				message: "model or Skill writable fields require update and exclusion semantics",
			});
		if (field.type === "enum" && Object.keys(field.value_meanings).length !== field.values?.length)
			context.addIssue({
				code: "custom",
				path: ["value_meanings"],
				message: "enum fields require a meaning for every value",
			});
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

export const CharacterStateEvidence = z.strictObject({
	source: z.enum(["current_user", "current_assistant", "user_choice"]),
	quote: z.string().min(1).max(2000),
});
export type CharacterStateEvidence = z.infer<typeof CharacterStateEvidence>;
