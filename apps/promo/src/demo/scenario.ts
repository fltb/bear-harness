import type { CharacterDisplay } from "@bear-harness/protocol";
import scenarioData from "./scenario.json";

export interface PromoScene {
	id: number;
	title: string;
	user: string;
	assistant: string;
	narration: string;
	narrationPlacement: "before" | "after" | "none";
	actions: string[];
	readingSeconds: number;
}

/** The audio owner's JSON is the one authoritative script; no duplicate prose is maintained here. */
export const SCENARIO: readonly PromoScene[] = scenarioData as readonly PromoScene[];

const NIGHT_READING_MARKDOWN = `# 夜读角
带一本想读的书，来坐一会儿。

- 自由参加，不安排轮流自我介绍。
- 想分享的时候再开口，也可以自己安静读书。
- 日期：待定。
- 报名方式：待定。
`;

export { NIGHT_READING_MARKDOWN };

const media = (id: string, label: string, url: string): CharacterDisplay["media"][number] => ({
	id,
	kind: "image",
	label,
	description: label,
	use_when: "预设情景展示",
	loop: false,
	url,
});
const theme = (
	canvas: string,
	surface: string,
	raised: string,
	accent: string,
	text = "#f3f5f0",
	muted = "#b8c4bf",
): CharacterDisplay["theme"] => ({
	radius: { sm: 4, md: 8, lg: 14 },
	tokens: {
		canvas,
		surface,
		surface_raised: raised,
		surface_interactive: raised,
		surface_selected: raised,
		text,
		text_muted: muted,
		text_on_accent: "#081c19",
		accent,
		accent_hover: accent,
		border: "#395048",
		border_focus: accent,
		success: "#79d5ae",
		warning: "#f2c56b",
		danger: "#ef6b73",
	},
	font: { body: "system-ui", heading: "system-ui" },
});
const meeting = (name: string): CharacterDisplay["character"]["first_meeting"] => ({
	step_label: "初次相遇",
	dialog_label: `和${name}打个招呼`,
	error_prefix: "无法继续",
	steps: [
		{
			id: "welcome",
			kind: "acknowledge",
			heading: "预设情景",
			body: "这是私有制作中的预设角色演示。",
			submit_label: "继续",
		},
	],
});
function baseCharacter(
	id: string,
	name: string,
	subtitle: string,
	colors: [string, string, string, string],
	sceneId: string,
	sceneLabel: string,
	sceneUrl: string,
	avatarUrl: string,
	expressionId: string,
	expressionUrl: string,
	greeting: string,
	mediaItems: CharacterDisplay["media"],
): CharacterDisplay {
	const [canvas, surface, raised, accent] = colors;
	return {
		id,
		name,
		language: "zh-CN",
		theme: theme(canvas, surface, raised, accent),
		character: {
			subtitle,
			greeting,
			composer_placeholder: "输入消息…",
			correction: {
				trigger_label: "修正回复",
				reason_group_label: "原因",
				presets: [
					{ id: "voice", label: "语气" },
					{ id: "fact", label: "事实" },
				],
				custom_label: "其他",
				custom_placeholder: "告诉角色哪里需要修正",
			},
			work_presentation: {
				labels: {
					proposal: "待开始",
					running: "正在处理",
					needs_user: "需要你的输入",
					interrupted: "已中断",
					completed: "已完成",
					failed: "处理失败",
					steer_placeholder: "补充要求…",
					interrupt: "中断",
					resume: "继续",
					approve: "同意",
					reject: "拒绝",
					artifact_open: "查看结果",
					artifact_reveal: "显示文件",
				},
			},
			first_meeting: meeting(name),
		},
		system_prompt: "这是白熊客栈私有制作中的预设情景角色，不调用实时模型。",
		scenes: [{ id: sceneId, label: sceneLabel, description: sceneLabel, backgroundUrl: sceneUrl }],
		visual: {
			defaultSceneId: sceneId,
			defaultExpressionId: expressionId,
			avatarUrl,
			expressions: {
				[expressionId]: expressionUrl,
				...(id === "jizhou" ? { happy: "/local-content/media/jizhou/expression-happy.png" } : {}),
			},
			expressionLabels: { [expressionId]: name },
		},
		media: mediaItems,
	};
}

export const DEMO_CHARACTERS: Readonly<Record<string, CharacterDisplay>> = Object.freeze({
	jizhou: baseCharacter(
		"jizhou",
		"极昼",
		"白熊客栈的夜班值守者",
		["#07171c", "#102a31", "#183a40", "#8bd0bb"],
		"study",
		"极光书房",
		"/local-content/media/jizhou/scene-aurora-study.png",
		"/local-content/media/jizhou/avatar.png",
		"presence",
		"/local-content/media/jizhou/expression-presence.png",
		"椅子擦干净了。",
		[
			media("continuity_light", "极光书桌", "/local-content/media/jizhou/cg-continuity-light.webp"),
			media(
				"future_beacon_cg",
				"极光下的灯火",
				"/local-content/media/jizhou/cg-future-beacon.webp",
			),
		],
	),
	rj: baseCharacter(
		"rj",
		"RJ",
		"曾经的警察，仍会守门的棕熊",
		["#171313", "#281d1b", "#3a2925", "#d98b62"],
		"street",
		"贫民区街口",
		"/local-content/media/rj/scene-street.webp",
		"/local-content/media/rj/avatar.webp",
		"normal",
		"/local-content/media/rj/expression-normal.webp",
		"让开点，我来。",
		[
			media("rj_card", "RJ 人物卡", "/local-content/media/rj/card-rj.webp"),
			media("rj_photo", "RJ 照片", "/local-content/media/rj/photo-rj.webp"),
		],
	),
	volibear: baseCharacter(
		"volibear",
		"沃利贝尔",
		"不灭狂雷",
		["#07131f", "#0b1b2b", "#132d43", "#77c7ef"],
		"frozen_river",
		"冰封河岸",
		"/local-content/media/volibear/backgrounds/frozen-river-v1.png",
		"/local-content/media/volibear/avatar-spirit-blossom.png",
		"presence",
		"/local-content/media/volibear/expressions/presence.png",
		"风还没停。",
		[
			media(
				"listening_under_ice",
				"冰下听水",
				"/local-content/media/volibear/cg/listening-under-ice-v1.png",
			),
		],
	),
});
