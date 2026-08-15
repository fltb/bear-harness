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

/** Product UI locale. Role-package language is declared independently. */
export const productLocale = "zh-CN";

/** Product-owned copy for generic application controls, separate from role packages. */
export const productUi = {
	shell: {
		fallbackComposerPlaceholder: "说点什么…",
	},
	composer: {
		attachLabel: "添加材料",
		attachTitle: "添加文本、Markdown、数据或代码材料",
		attachedCount: "份材料",
		messageInputLabel: "发送消息",
		sendLabel: "发送",
		storyConfirmation: "这句话要作为接下来故事里已经发生的设定吗？",
		storyAccept: "是，记进故事",
		storyDismiss: "不用，只是随口说说",
		materialLabel: "材料",
	},
	sidebar: {
		search: "搜索",
		newConversation: "新建对话",
		conversations: "对话",
		emptyConversations: "还没有对话。点右上角的 ＋ 开始第一段。",
		unreadMessage: "有未读消息",
		renameConversation: "重命名对话",
		saveConversation: "保存",
		archiveConversation: "归档对话",
		deleteConversation: "删除对话",
		deleteConversationConfirm: "确定永久删除这段对话吗？已形成的记忆不会一起删除。",
		application: "应用",
		relationshipArchive: "关系档案",
		roleManagement: "角色管理",
		systemSettings: "系统设置",
	},
	titlebar: {
		runningWork: "进行中的事",
		noRunningWork: "现在没有后台工作",
		backstage: "幕后",
		runningWorkItem: "正在处理的事",
		statusUpdating: "状态更新中",
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
		roleManagement: "角色管理",
		packageWorkshop: "角色包工坊",
		memory: "记忆",
		storyArchive: "故事档案",
		systemSettings: "系统设置",
		identitySuffix: "是谁",
		identityNote: "这份自我设定随产品版本锁定；普通对话和现实工作都不能改写它。",
		relationshipMemories: "已确认的关系记忆",
		storyOriginal: "原作设定保持不变。这里记录你们在当前故事中确认的变化。",
		storyEmpty: "当前故事还没有偏离原作的变化。",
		storyAddPlaceholder: "写下一条已经确定的故事变化…",
		storyBranchOnly: "只在这段故事里",
		storyAdd: "记下变化",
		storyUndo: "撤销",
		storyReset: "恢复原作",
		roleActive: "正在相处",
		roleSwitch: "切换角色",
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
		noActiveConversationError: "还没有选中对话",
		userMeta: "你 · 刚刚",
		responding: "正在回复",
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
		userEditBranchNote: "保存后会从这里开始一段新的对话分支，原来的后续内容不会丢失。",
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
		candidatesNote: "敏感或不确定的内容会先放在这里等你确认；明确的称呼与普通偏好会自动记住。",
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
		modelService: "模型服务",
		modelServiceHint: "选择用于角色回复的模型服务。密钥只保存在这台设备上。",
		primaryModelSection: "主模型",
		fallbackModelSection: "备用模型",
		serviceLabel: "服务",
		connected: "已连接",
		missingCredential: "未连接",
		apiKeyLabel: "API key",
		apiKeyStoredPlaceholder: "已保存，输入新密钥可替换",
		saveKey: "保存密钥",
		modelLabel: "主回复模型",
		textFallbackLabel: "文本备用模型",
		multimodalFallbackLabel: "多模态备用模型",
		textFallbackEnable: "启用文本备用模型",
		multimodalFallbackEnable: "启用多模态备用模型",
		textFallbackProvider: "文本备用服务",
		multimodalFallbackProvider: "多模态备用服务",
		textFallbackApiKey: "文本备用 API key",
		multimodalFallbackApiKey: "多模态备用 API key",
		textFallbackCustomToggle: "文本备用自定义服务地址",
		multimodalFallbackCustomToggle: "多模态备用自定义服务地址",
		textFallbackCustomUrl: "文本备用自定义 URL",
		multimodalFallbackCustomUrl: "多模态备用自定义 URL",
		customServiceName: "服务名称",
		noFallback: "不指定",
		advancedToggle: "高级模型设置",
		customBaseUrl: "自定义服务地址",
		customBaseUrlPlaceholder: "https://example.com/v1",
		customModelId: "自定义模型 ID",
		customApiKey: "自定义 API key",
		customSave: "保存服务地址",
		customSaved: "服务地址已保存，模型预设保持不变",
		useModel: "使用这个模型",
		modelSaved: "回复模型已更新",
		keySaved: "模型服务已连接",
		loginWithBrowser: "通过浏览器登录",
		oauthWaiting: "等待你在浏览器完成登录…",
		oauthOpen: "打开授权页面",
		oauthCode: "设备码",
		oauthSubmit: "继续登录",
		oauthConnected: "模型服务已连接",
		oauthFailed: "登录没有完成",
	},
	modelSetup: {
		dialogLabel: "连接回复模型",
		title: "先连接一个回复模型",
		description: "选择模型服务并完成连接。密钥只保存在这台设备上。",
		noProviders: "暂时没有可用的模型服务，请稍后重试。",
		continue: "使用这个模型开始",
		modelLabel: "回复模型",
		connecting: "正在连接模型服务…",
	},
	language: {
		warningTitle: "角色包语言与系统语言不同",
		warningBody:
			"这个角色包使用 {roleLanguage}，当前系统偏好 {userLanguage}。模型可以同时阅读多种语言，你仍然可以继续使用；角色包内的固定文案不会自动翻译。",
		dismiss: "知道了",
	},
	errors: {
		notFound: "没有找到这项内容，它可能已经被移动或删除。",
		conflict: "当前状态已经变化，请刷新后再试。",
		unavailable: "这项服务现在不可用，请检查设置后重试。",
		invalidRequest: "提交的内容不完整，请检查后重试。",
		generic: "操作没有完成，请稍后重试。",
		artifactUnavailable: "成果文件不可用",
	},
	canonStudio: {
		note: "高级制作区。原作资料保持只读；故事中的变化由普通用户在“故事档案”管理。资料会被稳定分段，回复时只检索与当前话题相关的片段。",
		sources: "原作资料",
		sourceName: "资料名称，例如 第一卷.txt",
		sourceText: "粘贴原文或设定资料…",
		addSource: "加入资料库",
		chunks: "个片段",
		remove: "移除",
		removeConfirm: "移除这份原作资料及其检索片段？",
		search: "检索与引用",
		modules: "剧情模块",
		moduleKind: "模块类型",
		moduleTitle: "模块名称",
		moduleInstructions: "说明这个模块何时使用、如何引导下一层模块…",
		moduleParent: "上一级（可选）",
		moduleNoParent: "没有上一级",
		saveModule: "保存模块",
		updateModule: "更新模块",
		editModule: "编辑",
		cancelEdit: "取消编辑",
		noModules: "还没有剧情模块。可以先检索原文片段，再建立入口、剧情段或事件模块。",
		references: "处原文依据",
		kinds: {
			root: "入口",
			arc: "剧情段",
			event: "事件",
			entity: "角色",
			relationship: "关系",
			location: "地点",
			object: "物件",
			behavior: "行为规则",
		},
	},
	work: {
		title: "现实工作",
		proposal: "行动确认",
		reads: "将读取：",
		writes: "将创建或修改：",
		network: "联网：",
		networkYes: "需要联网",
		networkNo: "不会联网",
		start: "开始处理",
		cancel: "取消",
		needsYou: "需要你决定",
		allow: "允许这一次",
		deny: "不允许",
		stop: "停下来",
		download: "保存副本",
		artifactStatuses: {
			created: "待检查",
			verified: "已检查",
			verification_failed: "检查未通过",
			adopted: "已采用",
			saved: "已保存",
		},
	},
} as const;

/** Locale catalog boundary. Additional product translations belong here, not in role packages. */
export const productUiCatalog = {
	[productLocale]: productUi,
} as const;
