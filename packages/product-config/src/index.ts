/**
 * Compile-time release identity and default character preset.
 *
 * This is the ONLY file a third-party fork needs to edit to build a fully
 * independent application: change the identity fields, brand license
 * declaration, icon and default character, then run `npm run build`.
 * The generic validator (`scripts/validate-product-config.mjs`) enforces that
 * any identity change also changes `appId` and `dataDirectoryName`, declares
 * `brandLicense.modified: true` and provides a modification notice.
 *
 * This file is erasable TypeScript: it uses only `type`/`interface` and plain
 * values, so it can be executed directly by Node 24 and by electron-builder.
 * It never reads environment variables or user files.
 */

export interface BrandLicense {
	/** Fixed: brand assets are CC BY-SA 4.0. */
	spdx: "CC-BY-SA-4.0";
	workTitle: string;
	creator: string;
	attribution: string;
	sourceUrl: string;
	/** True once any brand asset or identity field diverges from the official values. */
	modified: boolean;
	modificationNotice: string;
}

export interface ProductConfig {
	/** System install name and native window title fallback. */
	productName: string;
	/** Reverse-domain id; also used as the Linux desktop entry name. */
	appId: string;
	/** ASCII kebab-case; Electron `userData` subdirectory name under appData. */
	dataDirectoryName: string;
	/** electron-builder artifact macro template. */
	artifactName: string;
	/** ASCII kebab-case executable name. */
	executableName: string;
	/**
	 * ASCII kebab-case id of the DEFAULT character package. Points into
	 * `config/characters/<id>/character.yaml` — the package is the single
	 * source of all character content (name, canon, theme, copy). This file
	 * never holds character strings.
	 */
	defaultCharacterId: string;
	brandLicense: BrandLicense;
	/** Repo-root-relative path to a 1024x1024 PNG or a readable SVG, or null for the default icon. */
	icon: string | null;
}

export const productConfig: ProductConfig = {
	productName: "Cyber Bear",
	appId: "io.github.fltb.bear-harness",
	dataDirectoryName: "cyber-bear",
	artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
	executableName: "cyber-bear",
	defaultCharacterId: "jizhou",
	brandLicense: {
		spdx: "CC-BY-SA-4.0",
		workTitle: "Cyber Bear Brand Assets",
		creator: "fltb",
		attribution: "fltb — Cyber Bear Brand Assets",
		sourceUrl: "https://github.com/fltb/bear-harness",
		modified: false,
		modificationNotice: "",
	},
	icon: null,
};

/** Product-owned copy for generic application controls, separate from role packages. */
export const productUi = {
	shell: {
		fallbackComposerPlaceholder: "说点什么…",
	},
	composer: {
		attachUnavailableLabel: "添加材料（尚未接入）",
		attachUnavailableTitle: "材料导入尚未接入",
		messageInputLabel: "发送消息",
		sendLabel: "发送",
	},
	sidebar: {
		search: "搜索",
		newConversation: "新建对话",
		conversations: "对话",
		emptyConversations: "还没有对话。点右上角的 ＋ 开始第一段。",
		unreadMessage: "有未读消息",
		application: "应用",
		relationshipArchive: "关系档案",
		systemSettings: "系统设置",
	},
	titlebar: {
		runningWork: "进行中的事",
		noRunningWork: "现在没有后台工作",
		backstage: "幕后",
		runStatuses: {
			enqueued: "排队中",
			running: "正在处理",
			needs_user: "需要你",
			completed: "做好了 · 等你查看",
			failed: "没有做成",
			cancelled: "已取消",
			interrupted: "已中断",
			forced_termination: "被强制终止",
		},
	},
	backstage: {
		title: "幕后",
		close: "关闭",
		tabsLabel: "幕后分栏",
		relationshipArchive: "关系档案",
		memory: "记忆",
		systemSettings: "系统设置",
		identitySuffix: "是谁",
		identityNote: "这份自我设定随产品版本锁定；普通对话和现实工作都不能改写它。",
		relationshipMemories: "已确认的关系记忆",
	},
	webDev: {
		ariaLabel: "Web Dev 调试工具",
		title: "真实 Host 调试",
		close: "关闭",
		description: "所有调用直接经过当前会话的 loopback Host；不会触发 Electron 特有能力。",
		providerSection: "Pi 配置",
		loadProviders: "加载模型配置",
		sessionApiKey: "API key（仅当前 Web Dev 进程）",
		saveSessionKey: "保存到本次运行",
		rpcSection: "完整 RPC",
		rpcParameters: "JSON 参数",
		invokeHost: "调用真实 Host",
	},
	messages: {
		justNow: "刚刚",
		noActiveConversationError: "conflict: 还没有选中对话",
		userMeta: "你 · 刚刚",
		editLabel: "编辑消息",
		save: "保存",
		cancel: "取消",
		versionPager: "切换已生成版本",
		previousVersion: "上一个版本",
		nextVersion: "下一个版本",
		otherReason: "其他原因",
		submitCorrection: "提交校正",
		operations: "消息操作",
		regenerate: "重新生成",
		edit: "编辑",
		continue: "继续",
		branch: "从这里另开一段",
		conversation: "对话",
		operationFailedPrefix: "操作没有完成：",
		correctionReasons: ["语气不对", "忘了自己", "忘了共同经历", "替用户行动", "把虚构当现实"],
		correctionScopes: [
			{ id: "once", label: "仅这次" },
			{ id: "session", label: "当前对话" },
			{ id: "always", label: "以后都这样" },
		],
	},
	memory: {
		scopes: { self: "关于我", relationship: "关于我们", scene: "场景" },
		kinds: {
			fact: "事实",
			preference: "偏好",
			event: "事件",
			self_canon_summary: "自我设定",
		},
		pin: "置顶",
		unpin: "取消置顶",
		forget: "忘记",
		exclude: "排除",
		pinned: "置顶",
		loading: "正在读取…",
		emptyEntries: "还没有记住什么。确认“最近想记住”里的候选后，会出现在这里。",
		defaultEntriesTitle: "已记住",
		fallbackConversation: "对话",
		approved: "已记住",
		rejected: "已拒绝",
		saved: "已保存",
		approvedEdited: "已记住修改后的内容",
		recentCandidates: "最近想记住",
		candidatesNote: "候选来自对话与你的明确请求；只有你确认后才会写进记忆。",
		noCandidates: "没有待确认的候选记忆。",
		remember: "记住",
		edit: "修改",
		reject: "拒绝",
		editedContent: "修改后的记忆内容",
		saveEdit: "保存修改",
		searchPlaceholder: "搜索记忆…",
		searchLabel: "搜索记忆",
		search: "搜索",
		clear: "清除",
		scopeTabsLabel: "记忆范围",
	},
	settings: {
		note: "管理关系记忆。角色称呼与关系由首次见面决定。",
		loading: "正在读取…",
		relationshipMemory: "关系记忆",
		relationshipMemoryHint: "记住你明确确认的称呼、偏好与共同经历；不会把工作文件内容写进记忆。",
		relationshipMemoryEnabled: "关系记忆已开启",
		relationshipMemoryDisabled: "关系记忆已关闭",
	},
} as const;
