const actionParameters = (actions) => ({
	type: "object",
	properties: { action: { type: "string", enum: actions } },
	required: ["action"],
	additionalProperties: false,
});

async function callHost(tool, args = {}) {
	const bridge = globalThis.bearHostCall;
	if (typeof bridge !== "function") throw new Error("Companion Host bridge is unavailable");
	const result = await bridge(tool, args);
	if (!result?.ok) throw new Error(result?.message ?? `${tool} failed`);
	return result;
}

function result(value) {
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
		details: value,
	};
}

const mediaCues = {
	first_night: ["host_play_media", { mediaId: "first_night" }],
	damaged_signal: ["host_play_media", { mediaId: "damaged_signal_live" }],
	damaged_log_choice: ["host_present_choices", { choiceSetId: "damaged_log_response" }],
};

const damagedLogBeats = {
	0: {
		status: "unopened",
		fact: "一份带校验摘要的损坏日志副本仍未打开。",
		allowedActions: ["advance"],
		next: "征得用户同意后再次调用 advance，打开副本并保留原始数据。",
	},
	1: {
		status: "copy_preserved",
		fact: "原始副本已经保留；风暴噪声中存在不符合随机分布的重复间隔。",
		allowedActions: ["advance"],
		next: "再次调用 advance，比较时间戳并分离重复脉冲。",
	},
	2: {
		status: "pulse_isolated",
		fact: "重复脉冲已被分离，时间戳指向极光站关闭后的时段；信号来源仍未确认。",
		allowedActions: ["advance", "respond", "preserve"],
		next: "再次调用 advance 呈现回应或保存现场的选择，也接受用户自由输入。",
	},
	3: {
		status: "signal_answered",
		fact: "回应已经发出，微弱信号重新亮起；来源仍未确认。",
		allowedActions: [],
		next: "本章当前进度完成，不得虚构信号来源。",
	},
};

async function inspectDamagedLog() {
	const response = await callHost("host_get_roleplay_state");
	const rawStage = response.data?.values?.damaged_log_stage;
	const stage = Number.isInteger(rawStage) && rawStage >= 0 && rawStage <= 3 ? rawStage : 0;
	return {
		stage,
		preserved: response.data?.values?.damaged_log_snapshot_preserved === true,
		...damagedLogBeats[stage],
	};
}

export default function jizhouRoleplay(pi) {
	pi.registerTool({
		name: "jizhou_damaged_log",
		label: "损坏日志剧情",
		description:
			"损坏日志的单步状态机。每轮先 inspect，并且只执行返回值 allowedActions 中的动作：advance 推进一步或在阶段 2 展示选择；respond 回应信号；preserve 保存现场。事件只会在回复成功提交后持久化。",
		parameters: actionParameters(["inspect", "advance", "respond", "preserve"]),
		async execute(_toolCallId, { action }) {
			const state = await inspectDamagedLog();
			if (action === "inspect") return result(state);
			if (!state.allowedActions.includes(action))
				throw new Error(
					`Action ${action} is not allowed at damaged-log stage ${state.stage}; allowed actions: ${state.allowedActions.join(", ") || "none"}`,
				);
			if (action === "respond") {
				await callHost("host_trigger_roleplay_event", { eventId: "damaged_log_signal_found" });
				return result({ ...state, queued: "damaged_log_signal_found" });
			}
			if (action === "preserve") {
				await callHost("host_trigger_roleplay_event", { eventId: "damaged_log_preserved" });
				return result({ ...state, queued: "damaged_log_preserved" });
			}
			if (state.stage === 0) {
				await callHost("host_trigger_roleplay_event", { eventId: "damaged_log_opened" });
				return result({ ...state, queued: "damaged_log_opened" });
			}
			if (state.stage === 1) {
				await callHost("host_trigger_roleplay_event", { eventId: "damaged_log_pulse_isolated" });
				return result({ ...state, queued: "damaged_log_pulse_isolated" });
			}
			if (state.stage === 2) {
				await callHost("host_present_choices", { choiceSetId: "damaged_log_response" });
				return result({ ...state, presented: "damaged_log_response" });
			}
			return result(state);
		},
	});

	pi.registerTool({
		name: "jizhou_media_cue",
		label: "极昼的场面调度",
		description: "呈现角色包中预先声明的场景、CG、动图或选择卡。",
		parameters: actionParameters(Object.keys(mediaCues)),
		async execute(_toolCallId, { action }) {
			const [tool, args] = mediaCues[action];
			return result(await callHost(tool, args));
		},
	});
}
