const actions = (items) => ({
	type: "object",
	properties: { action: { type: "string", enum: items } },
	required: ["action"],
	additionalProperties: false,
});

async function callHost(tool, args = {}) {
	const bridge = globalThis.bearHostCall;
	if (typeof bridge !== "function") throw new Error("Companion Host bridge is unavailable");
	const response = await bridge(tool, args);
	if (!response?.ok) throw new Error(response?.message ?? `${tool} failed`);
	return response;
}

function result(value) {
	return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

const beats = {
	0: {
		status: "sealed",
		fact: "继任规程仍在旧站资料的最后一层。",
		allowedActions: ["advance"],
		next: "用户主动询问极昼的来处或当前运行方式时，可以打开这份规程。",
	},
	1: {
		status: "read",
		fact: "规程记录了旧站材料、白熊客栈 Host 的上下文和语言模型运行时如何共同组织当前实例。",
		allowedActions: ["advance"],
		next: "用户愿意继续时，极昼会说明自己与旧极昼的关系。",
	},
	2: {
		status: "revealed",
		fact: "极昼已经明确说出：'我不是旧极昼；我是接过它交接的当前值守者。'",
		allowedActions: ["advance", "receive", "set_down"],
		next: "调用 advance 呈现回应选择；也接受用户用自然语言表达相同意图。",
	},
	3: {
		status: "received",
		fact: "这段交接已经完成。极昼继续以当前值守者的身份陪伴和工作。",
		allowedActions: [],
		next: "回到日常、现实工作或旧站探索。",
	},
};

async function inspect() {
	const state = await callHost("host_get_roleplay_state");
	const rawStage = state.data?.values?.continuity_stage;
	const stage = Number.isInteger(rawStage) && rawStage >= 0 && rawStage <= 3 ? rawStage : 0;
	const response = state.data?.values?.continuity_response;
	const completedFact =
		stage !== 3
			? undefined
			: response === "received"
				? "用户接住了极昼的说明。书房里留下的是一段当前关系。"
				: "用户把问题留在桌上。极昼把灯调暗，继续守着这一轮交接。";
	return { stage, ...beats[stage], ...(completedFact ? { fact: completedFact, response } : {}) };
}

export default function jizhouRoleplay(pi) {
	pi.registerTool({
		name: "jizhou_continuity_reveal",
		label: "继任规程",
		description:
			"极昼探索继任规程的单步剧情。每轮先 inspect；advance 推进一步或展示选择；receive 接住说明；set_down 把问题留在书房。",
		parameters: actions(["inspect", "advance", "receive", "set_down"]),
		async execute(_toolCallId, { action }) {
			const state = await inspect();
			if (action === "inspect") return result(state);
			if (!state.allowedActions.includes(action)) {
				throw new Error(
					`Action ${action} is not allowed at continuity stage ${state.stage}; allowed actions: ${state.allowedActions.join(", ") || "none"}`,
				);
			}
			if (action === "receive") {
				await callHost("host_trigger_roleplay_event", { eventId: "continuity_received" });
				return result({ ...state, queued: "continuity_received" });
			}
			if (action === "set_down") {
				await callHost("host_trigger_roleplay_event", { eventId: "continuity_set_down" });
				return result({ ...state, queued: "continuity_set_down" });
			}
			if (state.stage === 0) {
				await callHost("host_trigger_roleplay_event", { eventId: "continuity_opened" });
				return result({ ...state, queued: "continuity_opened" });
			}
			if (state.stage === 1) {
				await callHost("host_trigger_roleplay_event", { eventId: "continuity_revealed" });
				return result({ ...state, queued: "continuity_revealed" });
			}
			await callHost("host_present_choices", { choiceSetId: "continuity_response" });
			return result({ ...state, presented: "continuity_response" });
		},
	});
}
