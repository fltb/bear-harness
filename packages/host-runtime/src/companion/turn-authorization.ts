export type TurnCapability = "history" | "delegate_pi" | "delegate_codex";

/**
 * A model request is not proof of user consent. Sensitive Host tools must also
 * match an explicit intent in the native user entry that triggered this turn.
 * False negatives are intentional: the model can ask the user to be explicit.
 */
export function hasTurnAuthorization(text: string, capability: TurnCapability): boolean {
	const normalized = text.normalize("NFKC").toLowerCase();
	if (capability === "history") {
		return (
			/(历史|之前|以前|过去|上次|其他对话|别的对话|跨对话|回忆)/u.test(normalized) ||
			/\b(history|previous|earlier|past|other conversations?|recall|remember)\b/u.test(normalized)
		);
	}
	const delegated =
		/(委托|代理|交给.{0,12}(处理|完成|执行)|让.{0,12}(代理|智能体|agent).{0,12}(处理|完成|执行)|单独.{0,8}(处理|任务))/u.test(
			normalized,
		) || /\b(delegate|delegation|agent|independently)\b/u.test(normalized);
	if (!delegated) return false;
	if (capability === "delegate_pi") return true;
	return /\bcodex\b/u.test(normalized);
}
