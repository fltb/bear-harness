# 角色优先工作交互与成果展示计划

> 状态：已确认的实现计划。本文覆盖角色化工作文案、消息级行动线、双列成果展示、图标系统和图片模型的显式路由。它不改变 Host 的权限、审计或执行决策权。

## 1. 产品原则

1. 聊天是默认入口；不复制 WorkBuddy 的 Ask / Plan / Craft / Expert 模式。
2. 现实工作由 Host 执行，角色只参与叙事和呈现。Host 永远拥有真实权限、路径、运行状态、产物元数据和审计事实的解释权。
3. 每一项现实工作必须锚定到触发它的用户消息。成果不是对话级附件，更不是全局面板内容。
4. 行动线展示过程；右侧双列成果区展示交付物。两者不能互相替代。
5. 关闭成果区只关闭视图，绝不取消工作、删除成果或回滚副作用。
6. 图片模型不能静默 fallback：当前模型不支持图片时，必须明确显示图片由哪个模型读取；没有可用图片模型时禁止发送并引导设置。
7. 模型直接按会话切换。不要引入“角色声音”、Voice Stack 或试演层。
8. “下级程序”只是极昼的角色表达，不能写死到 Host、协议或通用 UI。其他角色可以定义自己的工作称呼；未定义时使用中性文案。

## 2. 目标体验

```text
用户消息 M-42：把三份会议记录整理成周报。
  ↓
M-42 下方出现该消息的工作提案；用户看见准确的读写和网络范围。
  ↓
用户批准后，M-42 下方的行动线呈现执行进度、权限请求和可选详情。
  ↓
完成时，M-42 下方出现“查看成果”。当前正停留在这段对话时，首个安全可预览的主成果自动打开。
  ↓
左列保留角色、对话和输入；右列展示该消息产生的成果。
  ↓
关闭右列仅返回全宽对话，M-42 的成果、运行记录和“查看成果”入口仍在。
```

## 3. 数据归属与关联

### 3.1 不变量

```text
triggerMessageId
  └── commissionId
       └── runId
            └── artifactId[]
```

同一对话可有多个工作请求，因此 `conversationId` 不足以决定成果来源。右列的每个选择必须同时知道：

- `conversationId`
- `triggerMessageId`
- `commissionId`
- `runId`
- `artifactId`

### 3.2 协议变更

当前协议已有：

- `Commission.conversationId`
- `Run.commissionId`
- `Artifact.producerRunId`

新增 Host 固化字段：

```ts
Commission.triggerMessageId: MessageId
```

要求：

- 创建 commission 时由 Host 从真实请求上下文写入。
- Renderer 不得通过最近消息、文本相似度或时间猜测关联。
- 快照、重连、切换分支、重新加载后均按该关系恢复。
- 一条消息未来允许有多个 commission；显示与选择以 `triggerMessageId + commissionId + runId` 区分。

### 3.3 视图状态

```ts
type ResultSelection = {
  triggerMessageId: string;
  commissionId: string;
  runId: string;
  artifactId: string;
};

type ConversationResultState = {
  selected?: ResultSelection;
};

type WorkResultPreference = {
  triggerMessageId: string;
  runId: string;
  lastViewedArtifactId?: string;
};
```

- `selected` 是当前对话当前正在打开的右列结果。
- `lastViewedArtifactId` 是每条工作行动线的偏好，用于下一次打开时恢复 tab。
- 用户关闭右列后清空 `selected`；保留 `lastViewedArtifactId`。
- 不保留“用户已经关闭仍应自动弹出”的状态。

## 4. 行动线

### 4.1 组件结构

将独立 `WorkPanel` 解体并放入 `ConversationPanel` 的消息时间线：

```text
ConversationPanel
  ├── MessageItem
  ├── WorkTimelineItem
  │   ├── WorkProposalCard
  │   ├── WorkRunCard
  │   ├── PermissionCard
  │   ├── WorkCompletionCard
  │   ├── WorkFailureCard
  │   └── ToolTraceDetails
  ├── StreamingMessage
  └── RoleplayPresentation
```

`WorkTimelineItem` 通过 `triggerMessageId` 位于发起请求之后，不能将当前会话所有 commission、run、permission 和 artifact 粗暴聚在主区。

### 4.2 提案卡

默认由 Host 呈现事实：

```text
读取：~/Documents/meetings/*.md
写入：~/Documents/weekly-summary.md
网络：不访问网络
```

角色化仅覆盖标题与按钮。例如极昼：

```text
极昼要交给下级程序的事
[交给它们] [这次算了]
```

中性 fallback：

```text
工作提案
[开始] [取消]
```

`draft` 显示批准与拒绝；已批准的 commission 不得被要求二次批准。

### 4.3 运行卡

Host 内部状态归并为用户可读状态：

| 内部状态 | 用户呈现 |
| --- | --- |
| `enqueued` / 解析中 | 准备中 |
| `running` | 进行中 |
| `needs_user` | 等你决定 |
| `interrupted` | 已暂停 |
| `completed` | 已完成 |
| `failed` / `cancelled` / 强制终止 | 未完成 |

运行卡显示阶段、补充指示、暂停和继续。工具的完整原始过程默认隐藏在 `ToolTraceDetails`，用户按需展开“查看执行详情与证据”。

### 4.4 权限卡

权限卡必须挂在引发权限的行动线之内，清楚描述：

- 要做什么；
- 会影响哪个对象或路径；
- 影响类型：读取、写入、删除、网络或执行；
- 为什么此刻需要；
- 是否会覆盖已有内容。

角色可改变卡片标题，不能改变 Host 给出的副作用事实或权限选项。禁止 WorkBuddy 式 `bypassPermissions`、allow-always 和后台默认全权限。

### 4.5 完成卡

完成卡只列本运行的新成果：

```text
已完成 · 2 个成果
weekly-summary.md
weekly-summary.pdf
[查看成果] [查看依据]
```

主操作是“查看成果”，而不是孤立的“下载”。不把只读输入材料当作成果。

## 5. 双列 ResultSpace

### 5.1 布局

恢复 Prototype 06 的 `result-mode`：

```text
┌──────────────────────────────┬──────────────────────────────────────┐
│ 角色、场景、当前对话与输入框  │ 当前消息触发的成果                    │
│                              │ 标题、来源、状态、内容预览            │
│                              │ 打开、继续修改、保存、依据、关闭       │
└──────────────────────────────┴──────────────────────────────────────┘
```

- 左侧不是被冻结的背景：用户仍可阅读本轮对话、继续聊天和发起后续受限工作。
- 右侧不是 modal：它是当前对话上下文的一部分。
- 首次进入双列时，角色与对话区按 Prototype 06 让位；退出时恢复全宽布局。

### 5.2 打开

每条工作行动线拥有自己的“查看成果”：

```ts
openResult({
  conversationId,
  triggerMessageId,
  commissionId,
  runId,
  artifactId,
});
```

打开后：

- 右列只显示该 `runId` 的 artifact；
- 对应行动线增加 `data-result-open`，提供视觉选中态；
- 左列保持在触发消息附近；
- 右列顶部显示来源消息摘要和“定位到对话”。

点击“定位到对话”时，滚动并聚焦 `triggerMessageId` 与关联行动线，不改变当前成果。

### 5.3 自动打开

| 情形 | 行为 |
| --- | --- |
| 任务完成，用户仍位于触发对话且没有看别的成果 | 自动打开首个安全可预览主成果 |
| 同一对话但用户在阅读远处内容 | 不抢焦点；完成卡显示成果已返回 |
| 用户已切换到别的对话 | 不打开右列；工作概览和来源行动线显示已完成 |
| 用户正在看另一条消息的成果 | 不抢右列；新完成行动线显示未读完成标记 |
| 只有不可预览文件 | 打开文件结果页，不展示空白 iframe |

### 5.4 多成果

右列顶部使用成果 tab：

```text
项目进展报告                                      [×]
[weekly-summary.md] [weekly-summary.pdf]
来自：把三份会议记录整理成周报 · [定位到对话]
```

- tab 切换只更新 `artifactId`，不改变来源消息。
- 下次从同一行动线重新打开时恢复 `lastViewedArtifactId`。
- 该 artifact 已不可用时，选同次 run 中第一个可访问主成果；全部不可用则不打开结果列，行动线显示“成果已不可用”，但仍可查看依据。

## 6. 关闭逻辑

### 6.1 `×` 与 `Esc`

`×` 和 `Esc` 都只关闭当前会话的右列预览：

```ts
closeResult(activeConversationId) {
  resultStateByConversation[activeConversationId].selected = undefined;
}
```

它必须：

- 退出双列布局；
- 移除来源行动线的 `data-result-open`；
- 保持当前对话与滚动位置；
- 保留该行动线的成果入口；
- 保留成果、run、commission、审计与文件副作用；
- 保留该行动线的 `lastViewedArtifactId`；
- 将焦点还给打开来源：行动线入口、搜索入口或任务概览入口。

它绝不：

- 取消或删除工作；
- 删除 artifact；
- 撤销文件修改；
- 删除对话；
- 关闭其他对话的结果视图。

### 6.2 会话切换

- 切换到没有 `selected` 的对话：右列消失。
- 切换到有 `selected` 的对话：恢复目标对话自身的右列和最后选择。
- 切回用户曾手动关闭的对话：保持关闭；只有用户再次点“查看成果”才打开。
- 顶部工作概览跳转到来源对话与行动线，但不因旧任务自动重开结果列。

### 6.3 非关闭动作

| 操作 | 语义 |
| --- | --- |
| 关闭 / `Esc` | 不再看当前成果预览 |
| 继续修改 | 从当前成果发起新的受限工作 |
| 保存到… | 用户决定将结果写入目的位置 |
| 采用 | 用户确认这是当前要的成果版本；不等于写入 Relationship Canon |
| 撤销 | 对可逆真实副作用发起 Host 审计回滚 |
| 删除成果 | 单独确认后删除 Host 管理 artifact |

## 7. 产物 presenter

| 主成果类型 | ResultSpace 主内容 | 主操作 | 次级操作 |
| --- | --- | --- | --- |
| HTML / localhost 应用 | 安全 iframe 或内置预览 | 打开成果 | 新窗口、复制地址、查看依据 |
| Markdown / 文本 | 内联阅读器 | 继续修改 | 保存到、复制、查看依据 |
| 图片 | 大图与缩放预览 | 打开原图 | 保存、Finder、查看依据 |
| 音频 / 视频 | 内联播放器与字幕 | 播放 | 保存、Finder、查看依据 |
| PDF | PDF 或首屏预览 | 打开 | 保存、Finder、查看依据 |
| DOCX / XLSX / PPTX | 文件结果页；可用时接入预览器 | 系统打开 | 保存、Finder、查看依据 |
| 代码目录 / 项目 | 文件树与 README / 首文件预览 | 打开项目 | Finder、复制路径、查看依据 |
| 其他二进制 | 类型图标、元数据与校验状态 | 打开或下载 | Finder、复制路径、查看依据 |

第一版可直接依赖现有 `Artifact` 的 `mime`、`logicalName`、`producerRunId`、`status`、`artifact.read` 和 `artifact.url`。后续可增加 Host 生成的 `ArtifactPresentationHint`：

```ts
type ArtifactPresentationHint = {
  role: "primary" | "supporting";
  preview: "inline" | "external" | "none";
  title?: string;
  summary?: string;
};
```

该 hint 只能由 Host 基于真实成果产生；角色包和 Worker 不能伪造完成、校验或预览安全性。

## 8. 图片模型：显式路由与失败恢复

### 8.1 当前模型支持图片

正常发送，不显示冗余提示。

### 8.2 当前模型不支持图片，但配置了图片模型

发送前显示：

```text
这张图片将由 Vision Model (Vision Relay) 读取。
当前对话仍由 Ling 2.6 1T (Ant Ling) 回复。
```

- 不切换当前会话模型；
- 图片模型只产出视觉理解结果；
- 当前会话模型根据该结果继续回复；
- 该路由必须可见，不能静默。

### 8.3 没有图片模型

```text
当前模型不能读取图片。
要发送图片，请在系统设置中选择或添加支持图片的模型。
[去设置] [移除图片]
```

- Send 禁用；
- “去设置”直达 `SettingsSheet` 的图片模型设置；
- 只列出 `supportsImages === true` 的已配置模型；
- 没有候选时，明确引导添加支持图片的 Provider / 模型；
- 设置后回到 Composer 时，文本与附件不得丢失。

### 8.4 图片读取失败

```text
图片读取失败，消息尚未发送。
原因：图片模型暂时不可用。
[重试] [换一个图片模型] [移除图片后继续]
```

禁止：

- 忽略图片后自动发送文本；
- 由不支持图片的当前模型臆测图片内容；
- 静默改用另一个模型。

## 9. 角色化工作文案

角色包新增可选 `character.work_presentation.labels`：

```yaml
character:
  work_presentation:
    labels:
      proposal: "要交给下级程序的事"
      running: "下级程序正在处理"
      needs_user: "这一步得你决定"
      interrupted: "工作先停在这里"
      completed: "带回来的东西"
      failed: "没有办成"
      steer_placeholder: "补充一句要怎么做"
      interrupt: "叫停"
      resume: "继续处理"
      approve: "交给它们"
      reject: "这次算了"
      artifact_open: "打开"
      artifact_reveal: "在 Finder 中显示"
```

极昼配置“下级程序”；其他角色自行声明其语言。缺省时使用中性 i18n 文案。

限制：

- 只能覆盖标题、状态标签、按钮和占位文本；
- 不能覆盖权限范围、文件路径、工具名、真实执行状态、artifact 元数据、审计事实或 Host 决策；
- 不能用该字段注入 Prompt、权限策略或任意执行配置。

## 10. Font Awesome + Solid

### 10.1 技术选择

新增官方依赖：

```json
"@fortawesome/free-solid-svg-icons": "<pinned-version>"
```

新增本地 Solid `Icon` 组件，接收 Font Awesome `IconDefinition` 并通过 `<svg>` / `<path>` 输出。按需导入图标，不用图标字体、全局 DOM runtime、`innerHTML` 或维护较弱的第三方 Solid adapter。

### 10.2 迁移范围

| 当前符号 | 图标 |
| --- | --- |
| 搜索 | `faMagnifyingGlass` |
| 新建对话 | `faPlus` |
| 编辑 | `faPen` |
| 归档 | `faBoxArchive` |
| 删除 | `faTrash` |
| 设置 | `faGear` |
| 附件 | `faPaperclip` |
| 发送 | `faArrowUp` 或 `faPaperPlane` |
| 停止 | `faStop` |
| 更多 | `faEllipsis` |
| 重新生成 | `faRotateRight` |
| 记住这一刻 | `faBookmark` |
| 分支 | `faCodeBranch` |
| 上下版本 | `faChevronLeft` / `faChevronRight` |
| 运行中 | `faSpinner` |
| 成功 | `faCircleCheck` |
| 失败 | `faCircleExclamation` |
| 需要决定 | `faCircleQuestion` |
| 暂停 / 恢复 | `faPause` / `faPlay` |
| 下载 | `faDownload` |
| Finder | `faFolderOpen` |
| 预览 | `faEye` |

规则：

- 有文字的按钮：图标辅助文字；
- 纯图标按钮：必须有 `aria-label` 和 `title`；
- `faSpinner` 仅真实运行时旋转，并遵循 `prefers-reduced-motion`；
- 不再用 emoji 或 Unicode 字符充当正式控制图标。

## 11. 模型交互

保持现有 per-conversation route：

```ts
store.model.select(conversationId, providerId, modelId)
```

- Composer 直接展示当前模型并允许切换；
- 默认回复模型用于新会话初始 route；
- 设置页管理 Provider、模型池、默认回复模型和图片模型；
- 不引入角色声音、Voice Stack、模型试演或自动切换角色模型。

## 12. 实施阶段

### Phase A：图标基础设施

- 加入 Font Awesome 官方 free-solid 包与本地 Solid `Icon`；
- 迁移 Sidebar、Composer、ConversationPanel、ThreadHead、WorkPanel、Backstage 的控制图标；
- 补齐纯图标控制的 label、title、focus 与 reduced-motion 验证。

验收：没有正式 UI Unicode 图标残留；图标按需打包；现有键盘和可访问性测试通过。

### Phase B：消息级执行关联

- 在 `Commission` 新增 `triggerMessageId`；
- Host 创建、持久化、快照、恢复和事件投影该字段；
- 将 commission → run → artifact 映射到触发消息；
- 为单条消息的多个 commission / run 保留稳定排序与选择。

验收：同一会话的多次工作请求不串成果；刷新、重连、分支和切换会话后关联稳定。

### Phase C：角色化工作呈现词汇

- 扩展角色包 schema 与 `CharacterDisplay`；
- 实现中性 fallback；
- 极昼包填入“下级程序”词汇；
- 对字段做严格校验，禁止影响 Host 事实、权限和执行。

验收：极昼使用“下级程序”；未定义角色使用中性文案；更换角色不改变任何现实副作用或授权路径。

### Phase D：行动线取代独立 WorkPanel

- 将 proposal、run control、permission、artifact completion、tool details 移入 `ConversationPanel`；
- 删除 `App.tsx` 中独立 `<WorkPanel />`；
- 顶部工作胶囊仅保留跨会话概览和来源定位；
- 每条完成行动线提供“查看成果”“查看依据”。

验收：从一条用户请求开始，用户无需跳区即可批准、观察、补充、暂停、恢复并进入成果；权限始终在对应行动线内。

### Phase E：ResultSpace 双列成果交付

- 新增 `ResultSpace`、`ArtifactPreview` 与对话级选择状态；
- 恢复 Prototype 06 的左右布局及角色/对话让位动画；
- 实现消息级打开、tab、来源定位、自动打开策略、关闭、焦点归还和会话切换规则；
- 先实现 HTML、文本、Markdown、图片、音视频和通用文件结果页；后续接入 PDF / Office / 代码预览。

验收：右列始终只展示当前选择的 `triggerMessageId + runId + artifactId`；关闭不改变任何现实状态；不同对话和不同消息的成果互不串扰。

### Phase F：显式图片模型错误流

- 保留当前可见 fallback；
- 补齐无图片模型时的设置深链接、附件和草稿保留；
- 增加图片模型请求失败的重试、换模型、移除图片流程；
- 禁止任何图片静默降级或忽略。

验收：覆盖当前模型支持图片、显式图片模型、没有图片模型、图片读取失败和设置返回五条路径。

## 13. 验证

- 单元测试：commission 消息归属、artifact 选择回退、关闭语义、会话切换、多个成果 tab、图片模型路径、角色文案 fallback。
- Host 集成：从用户消息创建 commission，到 run、permission、artifact 和审计链的完整关联。
- Web E2E：完成主成果自动打开、手动关闭、回到来源、切换对话、恢复 tab、图片模型未配置→设置→返回→发送。
- Electron smoke：`bear-artifact://` URL、Finder / 系统打开、HTML 预览安全边界、关闭预览后的焦点归还。
- 可访问性：所有纯图标按钮、结果列 `Esc`、tab 键顺序、焦点陷阱不存在、reduced-motion。

## 14. 明确不做

- WorkBuddy 式 Ask / Plan / Craft / Expert。
- 全局任务面板替代对话内行动线。
- `bypassPermissions`、allow-always 或后台默认全权限。
- 写死“下级程序”的通用 UI 或 Host 协议。
- 角色声音、Voice Stack、模型试演或模型静默切换。
- 关闭右列即删除、取消、采用或撤销。
- 将输入材料、只读文件或未验证输出伪装成最终成果。
