# Superseded Cyber Bear Working Notes

> **非权威记录。** 本文包含已废弃、推测或被后续用户决定覆盖的内容，不得作为产品、实现或测试依据。
>
> 当前实现以 [`refernece/architecture.md`](./refernece/architecture.md) 及 [`refernece/index.md`](./refernece/index.md) 所链接的模块参考为准；下文仅保留为已被取代的历史讨论。

## 1. 状态, 目的与范围

### 1.1 状态标记

| 标记 | 含义 |
| --- | --- |
| 产品决定 | V1 的强制行为。实现、测试和后续文档必须遵守。 |
| 实现门槛 | 产品行为已经决定；在能力未被实证前，相关入口不可启用，不能以猜测的降级实现替代。 |
| 外部调研事实 | 来自公开资料的可核对事实，用于选择实现，不自动扩大产品范围。 |

本文是合并后的契约，不保留已被新决定覆盖的方案。发生歧义时，本文当前的产品决定与实现门槛优先于 §11 外部调研；运行时则严格按 **Host Runtime Kernel > 当前 session pin 的 Prompt Profile > Core Preset 默认资源 > 外部参考/market package** 处理。高层 prompt 不能推翻低层代码边界。


### 1.2 目的

本文闭合 Cyber Bear V1：用户如何委托和验收、多个会话如何共存、何时压缩上下文、哪些记忆持久化、Pi 与 Codex 如何执行、权限如何收敛，以及失败时系统必须呈现什么。六个月后阅读本文的人应能直接实现和验收，不需要再把产品问题回抛给用户。

### 1.3 V1 范围

V1 只支持 macOS 15 或更高版本、Apple Silicon。产品内部是 Cyber Bear Host 与嵌入式 Pi Companion；熊可以在用户需要时经 Host 进行有限的查证、思考、记忆和自身设置。所有真正改变外界或产出正式工作结果的事，都经过外部 Executor Profile：Pi RPC Worker、Codex App Server 或 Hermes Console。用户可从 Pi Package Gallery 下载 worker add-on。没有云端团队编排、定时无人值守任务、通用 OS automation、未隔离的第三方代码 extension、第三方自定义 executor 或跨平台承诺。

### 1.4 固定术语

| 术语 | V1 契约 |
| --- | --- |
| 本地（local） | Cyber Bear 的 Host、状态库和产物库在本机运行。模型 provider、Companion 的 read-only lookup、有限 web research 与外部 profile authentication 可以联网；产品不承诺离线模型或零网络。 |
| Action Commission | 用户确认前不可执行的、schema 校验后的行动卡。固定列出目标、交付物、验收证据、Skill/executor/版本/模型、workspace、effect 与 envelope、时间/工具限额。Micro Commission 是同一契约的内联精简呈现，不能绕过批准。 |
| commission envelope | 单个 commission 不可变的约束：workspace/worktree、可读写路径、允许的工具类别和网络域、时限、最多 80 次 effectful tool call，以及明确排除的行为。effective permission 永远是该 Executor Profile policy 与此 envelope 的交集。 |
| Execution Skill | 真实工作的带版本能力，绑定一个外部 Executor Profile。V1 包含 `pi.rpc-worker`、`codex.app-server`、`hermes.console`；每个 commission 固定记录实际版本，绝不隐式替换或 fallback。 |
| executor | 在 frozen Commission Packet 外运行的 effectful runtime。Pi Worker 是 `pi --mode rpc` sidecar，Codex 是本地 `codex app-server` thread，Hermes 是 Host-owned PTY/adapter profile。三者都不能直接写 renderer、DOM 或 operational truth。 |
| 桌面 Host | 产品控制面、唯一 UI state owner 和 canonical journal writer。它创建 session/run、持久化事件与证据、编排 queue、生成 Context Pack、代理 approval，并规范化 executor stream。 |
| operational truth | Host journal 中可复验的状态、证据、权限/委托决定和用户 acceptance。模型文本、角色台词、动画、桌宠状态和未佐证的 executor 声明都不是 operational truth。 |
| evidence（证据） | 带来源、时间、哈希和 commission/run 归属的运行事件、文件 diff、命令退出码与输出、测试报告、网络响应元数据或用户确认。缺失、冲突或中断的证据必须产生 `unknown`，不能产生成功。 |
| Companion Session | 一个用户可见的熊对话。它可以恢复、归档和压缩，且只读取 relationship memory、用户选择的 project memory 与自身摘要。 |
| Worker Session | 每个 commission attempt 的独立工作会话；从无 relationship 内容的 Commission Packet 创建。它不从 Companion Session fork，也不接收完整聊天历史。 |
| Context Pack | Host 生成并持久化哈希的、用途受限的上下文输入。worker pack 只含 Commission Packet、已选 project facts、自己的 checkpoint 与运行事实；relationship memory 永不进入。 |
| Compaction Checkpoint | Host 绑定原始事件区间、证据引用和摘要的不可变上下文检查点。摘要只服务后续提示词；原始 journal 才是事实。 |
| durable memory | Host 持有的 canonical memory ledger；relationship/project 的语义索引与提炼由私有、本机的 TencentDB MemoryCore 维护且可从 ledger 重建。它分为 relationship、project、operational 三个 namespace，不是任意会话 history 的别名。 |
| harness profile | 一个可发现、可验证、由用户启用的外部 executor 安装。V1 profile 是 `pi.rpc-worker`、本地 Codex App Server 与本地 Hermes Console；发现从不自动授予执行权限。 |
| limited parallel commissions | 全局最多两个正在执行的 commission；同一 workspace 同时最多一个写入型 commission。每个仍有独立 envelope、worker 和证据流。 |
| Cyber Bear Core Preset | 内置 Pi 的 version-pinned first-party **默认 Companion Base Prompt**。它属于产品代码、仅可由 Host 私有 ResourceLoader 提供，不是用户可替换的第三方 package，也不是 Host 的 context/evidence/progress/UI capability。默认或 `extend` Profile 才注入它；`replace` Profile 不自动注入。 |
| Marketplace Worker Add-on | 从 Pi Package Gallery 或用户指定 npm/git source 下载、按 version/ref/hash 锁定的 Pi package。Markdown instruction add-on 可附加到单个 Pi RPC Worker；代码 extension add-on 只能在隔离的 Pi Worker 中启用。它们不能进入 Companion。 |
| Product Kernel | Host、Companion Identity、嵌入式 Pi Companion、first-party Core Preset、Commission/permission/evidence/memory/UI projection。只有 Host 可以将输入写成 operational truth。 |
| Executor Profile | Host 管理的外部 runtime adapter。它只能接收 frozen Delegation Packet，回传 event、evidence、console stream 和退出状态；没有产品 UI、关系记忆或 Host secret。 |
| Executor Console | 嵌在 Commission 的用户直接操作面：Brief、Agent Console、Worktree Terminal，以及 profile 支持时的 Native TTY。它区分 agent steer 与用户自己的 shell action。 |
| Companion 的有限感知 | 熊为回答用户当前问题而向 Host 请求的一小段查证、计算、回忆或自身设置能力。它不拥有网络、文件、凭据或 shell；Host 保留调用来源和结果依据。 |
| Micro Commission | 为单一、用户明确请求的 artifact 或外部 effect 提供的紧凑 Commission card；仍记录 provider、成本/模型、输出目标、evidence 和用户批准。 |
| 机魂状态图 | Host 持有的、带来源和新鲜度的本机环境摘要：用户授予的项目根目录、工作树、分支/状态、已启用 profile、有效权限和正在运行的委托。它不是对整台电脑的全盘窥视。 |
| Prompt Profile | 用户可写完整 system prompt 的版本化 Companion 配置。它可选择叠加 Core Preset 默认 Base Prompt，或替换所有自动注入的 first-party 人格/行为指令；Host 的事实、权限、evidence、UI truth、typed capability facade 与 worker 隔离仍在其外，由代码强制。 |
## 2. North-star statement

Cyber Bear 是一个本地的, 高度风格化且沉浸式的角色化数字助理. 用户永远先和熊说话; 熊负责理解意图, 澄清边界, 形成可检查的行动委托, 陪伴受约束的执行, 再把带有证据的结果交还给用户明确验收.

产品的核心不是让熊以拟人叙事代替事实, 而是让陪伴关系降低委托复杂度, 同时让真实执行边界, 权限, 状态和证据始终清楚可见.

下列单向约束贯穿各层:

```text
已验证的 operational truth
        |
        +--> 主界面事实, 状态, 错误, diff, 测试与证据
        +--> 熊的语气, 叙事和已知状态
        +--> 可选桌宠的有限视觉状态

叙事, 动画, 桌宠互动, progression
        |
        +--> 只能读取已验证事实, 不能改写任务, 权限, 审批, 成本或成功结论
```

## 3. 已确认的交互契约

### 3.1 用户与熊的基本关系

| 事项 | 已决定的契约 |
| --- | --- |
| 入口 | 用户始终先向熊表达意图，不存在独立的 executor 对话首页；Commission 运行后，用户可在同一主应用内、清楚标注来源的 Executor Console 直接 steer 或接管外援。 |
| 关系 | 这是 companion-style delegation assistant: 熊既陪伴用户, 也负责把意图整理成可执行委托. |
| 澄清 | 熊应自然地澄清和帮助, 直到任务边界足以形成委托草稿. |
| 执行前 | 真实工作前必须展示一张清晰的 Action Commission card. |
| 执行中 | 委托范围内持续运行; 熊继续陪伴用户, 不把正在运行误说成已经完成. |
| 返回后 | 返回报告, 等待用户明确 acceptance. |
| 状态语义 | run 和 user acceptance 是两个不同状态. 运行结束不等于用户已接受. |

### 3.2 生命周期

```text
用户输入 -> 澄清 -> schema-valid Commission draft -> 等待确认
                                             | edit / reject
                                             v
                                 approve -> queued -> running
                                                        |
                    +-----------------------------------+----------------------------------+
                    |                                   |                                  |
                    v                                   v                                  v
              needs user <------------------------ paused(revoked)                 terminal run
                    |                                   |                         completed/failed/
                    +-------- 用户回答或再次确认 --------+                         canceled/unknown
                                                                                          |
                                                                                          v
                                                                                  returned result
                                                                                          |
                           +-------------------+----------------------+-------------------+
                           |                   |                      |                   |
                           v                   v                      v                   v
                        accepted          request change          rejected            archived
                                              |
                                              +--> 新 draft / 新 commission
```

用户对 draft 只能 approve、edit 或 reject。用户对 returned result 只能 accept、request change 或 reject。`request change` 创建新的 commission；任何 terminal run 都不自动变成 accepted。
### 3.3 交互呈现

| 状态 | 已决定 |
| --- | --- |
| 主场景 | 对话和场景是主界面, 角色沉浸感不能遮蔽事实. |
| 证据入口 | 行动和真实证据放在始终可用的 drawer 中. |
| 证据模式 | 提供一键 evidence-only mode. |
| 语言 | 用户可使用普通自然语言, 也可选择使用仪式化语言. 仪式化语言是可选表达, 不是另一套执行协议. |
| 角色与事实 | 强角色声音和 2.5D 肖像可以存在, 但必须与明确的普通语言事实, 状态, 错误, diff 和测试并列. |
| 输出 | 以文字为先. TTS 只有用户主动选择时才启用. |
| 通知 | 桌面通知只报告关键状态, 不将每个运行步骤变成打扰. |

### 3.4 Default Core Preset、Prompt Profile 与 UI 投影

所有 Companion Session 共享一个持久化的 **Companion Identity**：关系记忆归属、用户偏好、视觉主题和通知偏好始终是同一位本机 Companion；它不是多个互相污染的角色。每个 session 同时 pin 自己的 Prompt Profile version，因此声音、文风和文字人格可以因用户选择的 `extend`/`replace` Profile 而不同；这不会复制、混合或越权读取另一 session 的 transcript/memory。

当 session 使用默认 Profile 或 `extend` Profile 时，Core Preset 提供以下**软性默认**：

1. 默认回复最多两句；只有 Commission card、结果报告或用户要求展开时才变长。
2. 仅在缺少阻塞信息时问一个最小问题；其他不确定性写为 draft 中可编辑的 assumption，不进行追问链。
3. 熊把自己当作本机的机魂：对简单的解释、一次查证、回忆和设置调整亲自处理；多步骤、长时或 effectful 工作默认建议交给外部 worker，并明确说出是谁在做。
4. “机魂不悦”“请下级程序代劳”是对软件进程的默认玩笑，不针对用户或人类；它不能成为拖延、推诿、隐藏错误或贬低外部 executor 结果的借口。

下列是 **Host Runtime Kernel**，不是 Core Preset 或可编辑 prompt：状态提示只能从 Host 已验证事实生成；后台 session 的模型文本不得注入当前聊天，关键事件只由 Host 写入 global work rail 与 origin session；模型只能提交类型化 `CompanionPresentationIntent`。

Host 计算最终 UI：`UIProjection = operational truth + active session focus + validated presentation intent`。operational truth 优先；模型、Prompt Profile 或 market package 不能设置事实文字、badge、进度、错误、按钮可用性或通知等级。

| 已验证状态 | 主肖像/桌宠 | 固定工作 UI |
| --- | --- | --- |
| 无活跃 Commission | `idle` 或 `attentive` | 对话输入；无浮层。 |
| draft / 等待确认 | `planning` / `awaiting_commission` | 固定 Commission card，不自动展开或批准。 |
| 当前 session 的 run | `working` | work rail、证据 drawer、取消入口。 |
| `needs_user` / `paused_revoked` | `needs_user` | 单个明确待决动作，其他 UI 不闪烁。 |
| `returned_result` | `returned_result` | 报告、evidence 和 accept/request-change/reject。 |
| `failed` / `unknown` | `unknown` | 错误/断连 evidence，绝不播放庆祝效果。 |

沉浸层只占 Presence Plane：肖像、短文本、环境动画和可选桌宠。Evidence、Commission、queue、work rail 和输入框构成恒定 Work Plane；Presence Plane 不移动焦点、不遮挡卡片、不弹出步骤级通知，也不在用户输入时发起模型回合。

## 4. 熊的角色, 呈现与桌面伴随层

### 4.1 角色边界

| 标记 | 决定 |
| --- | --- |
| 产品决定 | 产品默认是高度风格化的本地桌面沉浸式角色助理；默认文字人格是机魂熊，但 Prompt Profile 可以改变文字人格与行为。 |
| 产品决定 | 默认机魂熊是原创、具有神力设定的拟人北极熊；只借鉴 Volibear 的氛围感，不使用 LoL 名称、资产或 lore。`replace` 只重写文本 prompt，不替换产品的资产、运行时边界或事实 UI。 |
| 产品决定 | 默认 Profile 中的熊守着用户允许它看见的项目、环境和权限，嘴硬、懒得亲自动手，却对用户的工作环境负责任。它可以开“机魂不悦”“让低级程序去写”的玩笑；“低级程序”只指被委托的软件进程，绝不指用户或人。 |
| 产品决定 | 默认 Profile 中，熊的懒不是逃避：简单的解释、查证、记忆和设置调整由它编排；需要执行的工作默认明确外派给 Pi Worker、Codex 或 Hermes，Host 仍追踪委托、证据和结果。`replace` 可以改写这些软性表达和外派偏好，不能改变 Host 的实际执行边界。 |
| 产品决定 | 无论 Profile 如何，Companion 只能说自己从机魂状态图中确实知道的事，使用“我这里记录到/目前看见”而不是全知口吻；看不到、过期或冲突时 Host 令其显示 `unknown`。 |
| 产品决定 | 默认 Profile 使用固定的文字角色声音、可选 ritual-language toggle 和有限的 2.5D 肖像状态；Prompt Profile 可改文字声音，但 TTS、视觉资产和执行协议仍由 Host 设置，不能被 prompt 改写。 |
| 产品决定 | 默认机魂熊的角色表达服务于关系和理解，不能伪造运行事实或代替用户作出批准；任何 Prompt Profile 的文字表达同样受 Host 的事实与批准边界约束。 |

### 4.2 独立桌宠

桌宠是用户主动启用的可选层, 不是主应用的强制入口, 也不是另一个执行器.

| 事项 | 已决定的规则 |
| --- | --- |
| 窗口 | 仅 macOS 15+ Apple Silicon：可选的独立、draggable native floating window。 |
| 启用 | 必须由用户启用，默认关闭。 |
| 布局记忆 | 记住位置和尺寸。 |
| 安静条件 | 收到 macOS 的 DND、screen-sharing、presentation 或 fullscreen 抑制信号时自动安静；若系统未提供信号，仍不播放声音且永远不抢焦点。 |
| 焦点 | 永远不抢焦点. |
| 可做的事 | 只支持 cosmetic tap, hover 和 drag. |
| 导航 | 只能打开主应用中的相关视图. |
| 事实来源 | 有限视觉状态只由已验证事实驱动. |
| 允许状态 | `idle`/`attentive`、`planning`/`awaiting_commission`、`working`、`needs_user`、`returned_result`、`unknown`；前一项是 Host 对 CompanionPresentationIntent 的明确映射。 |
| 权限边界 | 桌宠不能批准, 取消, 扩大委托, 修改权限, 宣布成功, 或直接启动 effectful work. |

桌宠的 `unknown` 是真实可见状态, 不是用动画猜测结果. 桌宠和熊的叙事都必须服从同一个 operational truth.

### 4.3 主应用与桌宠的关系

```text
                 已验证事实
                    |
          +---------+---------+
          |                   |
          v                   v
    主应用对话/证据       可选独立桌宠
          |                   |
          |                   +--> cosmetic interaction
          |                   +--> 打开相关主应用视图
          v
    effectful action 只能在主应用委托流程中发生
```

## 5. 技能与执行器

### 5.1 Execution Skills

Execution Skills 是 versioned 的 `pi.rpc-worker`、`codex.app-server`、`hermes.console` 外部 profile；只在用户确认后的 envelope 内工作。用户选择意图；Host 在 Commission card 上提出实际 executor、版本和理由；用户确认该卡才允许启动。

每个 Execution Skill manifest 固定声明：`skill_id`、semver、executor kind、最低 adapter/protocol 版本、输入 schema、产物/证据 schema、允许的 effect 类别和默认模型 profile。manifest 不含关系提示词，不拥有 UI 写入权。

### 5.2 版本、替换与撤销

Commission 启动前，Host 完成 Execution Skill manifest、adapter 与所选 profile 的兼容性检查，并记录 Prompt Profile、Execution Skill、adapter、executor binary 与 model profile 的确切版本。Execution Skill、attached add-on、executor binary 或 profile 被撤销/变更/失效时，运行中的 commission 立即暂停，Host 保留 journal 与 worktree，只有用户再次明确确认后才可继续；新 commission 一律不可使用该版本。

没有隐式 fallback：Pi 不可用时不会改用 Codex；Codex 不可用时不会改用 Pi。Host 可以生成新的 draft 并明确说明替代 executor，但它仍须重新确认。

### 5.3 Cyber Bear Core Preset

这里有两个不同层，不能再统称为“Core Preset 行为”。**Core Preset 只在 Product Kernel 的 prompt-resource 层**：它提供默认 Companion Base Prompt。下表中记忆、上下文、thinking、查证、UI、批准和 evidence 则是 **Host Capability Facade / Host Runtime Kernel** 的职责；Core Preset 最多提供默认文字行为。它参考 [pi-setup](https://github.com/setwhite/pi-setup) 的“开箱即用”目标，但不复制其全量第三方 extension；未审查 package 不能静默替换任一层。

| 默认能力目标 | 实际 owner 与执行层 | Core Preset 的默认贡献（只在 default/`extend`） | 明确不采用的 pi-setup 直接依赖 |
| --- | --- | --- | --- |
| 长会话与记忆 | Host checkpoint、Host memory ledger、随 app 打包的 MemoryCoreHelper 与 UI context meter。 | 默认文本行为如何引用 Host 提供的 Context Pack；不能直接读写记忆。 | `pi-observational-memory`、`pi-context-usage` 不能成为第二事实源。 |
| 模型思考 | Host model policy：Companion 的实际 thinking level 与外部 worker 的 model profile 分别按请求/Commission 选择并记录。 | 默认回答与 draft 的思考偏好；custom prompt 不能替外部 worker 改模型或预算。 | `pi-preferred-thinking` 不拥有 profile 选择权。 |
| 有限事实查证 | Companion 只能发类型化 `request_limited_lookup`；Host 执行一次 read-only lookup 并保留来源。worker 的 network read 只可在已批准 envelope 内发生。 | 默认何时应请求查证、如何引用结果。 | `pi-chrome` 与 `rpiv-web-tools` 不能绕过 Host policy 或 worker domain allowlist。 |
| 状态与反馈 | Host 根据 operational truth 计算 progress、context meter、桌宠/主肖像和关键通知。 | 可提交受验证的 `CompanionPresentationIntent`。 | `pi-jingle`、`pi-btw` 不能自行改变呈现。 |
| 用户决定 | Host 的 Commission/approval/acceptance UI 是唯一入口。 | 可提出 `request_user_input`，不能批准。 | `rpiv-ask-user-question` 不能另起批准通道。 |
| 工具输出 | Host 把 lookup/executor 输出记录为 artifact/evidence；UI 可折叠展示但不可丢失。 | 只解释 Host 已提供的结果。 | `pi-rtk-optimizer`、`pi-fff` 不能改写工具/证据语义。 |

Host 私有 ResourceLoader 只提供锁定的 Companion Base Prompt；Host Capability Facade 独立提供类型化 request，不是 Core Preset resource。ResourceLoader 不写入用户的 `~/.pi/agent/settings.json`，不继承用户全局 packages，也不允许 Core Preset 直接改变 UI operational truth。`replace` Profile 的 compiled prompt 不得自动含有 Companion Base Prompt。

### 5.4 内部 Kernel 与外部 Executor Boundary

“内部/外部”按**控制权与 effect 权限**划分，不按进程是否由我们编译划分。

| 层 | 属于什么 | 可以做什么 | 明确不能做什么 |
| --- | --- | --- | --- |
| Product Kernel | Host、Companion Identity、嵌入式 Pi Companion、Core Preset、journal、memory、UI。 | 对话、澄清、draft、Context Pack、证据规范化、UI projection、用户决定，以及经 Host facade 执行非 effectful lookup/compute/settings。 | 启动 effectful work、直接执行 shell/未受控 network/write、把模型文字写成事实。 |
| External Executor Profile | Pi RPC Worker、Codex App Server、Hermes Console。 | 只在 frozen Commission Packet 与 worktree/envelope 内运行，回传原生 stream 与可核验产物。 | 读取 relationship/Companion history、直接改 UI/permission/acceptance，或在没有 Host authorization 时扩大 scope。 |
| User Console Action | 用户在 Executor Console 中直接输入的 steer 或 shell command。 | 控制 agent，或在同一 worktree 中亲自操作。 | 被伪装为 agent effect、绕过 journal，或与运行 worker 并发写入。 |

因此 Pi **Companion** 是内部产品能力；Pi **Worker** 即使使用我们随产品交付的 Pi binary，也一律是 External Executor Profile。它只拿 Delegation Packet，运行在 sidecar 中，和 Codex/Hermes 享有相同的 adapter、evidence、console、version pinning 与暂停规则。

Pi Package Marketplace 也不属于 Companion/Core Preset。它是 Pi RPC Worker 的 external add-on surface，见 §10.2；任何 package 都不能改变 Product Kernel 或跨越 Commission 边界。
## 6. 会话、外部执行器与直接操作

### 6.1 会话和运行对象

产品不再把“一个 Pi session”误当成“一个产品”。V1 使用四类独立对象：

| 对象 | 所属边界与持久化 | 可读取内容 | 用途 |
| --- | --- | --- | --- |
| Companion Session | Product Kernel；每个用户对话一个，可恢复、归档和切换。 | relationship、用户选中的 project facts、自己的摘要。 | 熊的陪伴、澄清和 Commission draft。 |
| Pi RPC Worker | External Executor Profile；每个 Pi commission attempt 一个 sidecar session。 | 仅 Delegation Packet、被批准的 project facts、自己的 journal/checkpoint。 | Pi 调研、写作或代码工作。 |
| Codex Thread | External Executor Profile；每个 Codex commission attempt 一个 App Server thread。 | 与 Pi worker 相同的 packet；不含 relationship 或 Companion history。 | Codex 代码工作。 |
| Hermes Run | External Executor Profile；每个 commission attempt 一个 Host-owned PTY 或结构化 adapter session。 | 与 Pi worker 相同的 packet；不含 relationship 或 Companion history。 | Hermes 的原生 terminal-centric 工作流。 |

Companion Session 可以在任一 worker 运行时继续对话；它不能直接篡改 worker。用户对运行任务的回复先由 Host 分类：在 envelope 内的补充才作为 `steer`/`follow_up` 交给 profile；任何 scope、executor、permission 或交付物变化都创建 revision draft。

Host 在本机 session registry 中记录 `conversation_id`、`commission_id`、`run_id`、profile、profile version、原生 session/thread/PTY handle、状态和恢复指针。Host journal 是跨重启的 canonical state；任何 executor 自己的 session store 只用于恢复运行 history。

### 6.2 自动上下文压缩

Host 对每个 Companion/Worker Session 维护保守 token 预算。估算输入达到该模型有效 context window 的 70% 时，在当前 tool call 结束后触发压缩；85% 是硬上限，禁止再向该 session 注入普通 prompt。

压缩顺序固定：

1. Host 先事务性写入该区间的 journal、证据引用和 `Compaction Checkpoint`。
2. 对 Companion，Host 在同一 Conversation 内以该 checkpoint 建立新的嵌入式 Pi continuation；对 Pi RPC Worker 发送 `compact`，向 Codex 发送 `thread/compact/start`；Hermes profile 必须回传等价 checkpoint 或由 Host 创建新 attempt。
3. Host 校验压缩后 history 低于 65% 预算，并把摘要、原始区间和版本哈希关联到 checkpoint。
4. 压缩失败、无效或仍超过 65% 时，Host 对 Companion 创建同一 Conversation 的新内部 continuation；对 worker 创建同一 commission 的新 attempt，从最近 checkpoint 加 Delegation Packet 恢复；原 session/worker 标为 `continued`，不是成功。

原始事件、diff、测试输出、approval 和 envelope 永不因压缩删除。摘要没有事实写入权；任何只出现在摘要中、没有 journal/evidence 的结论必须显示为未验证。

### 6.3 内部 Pi Companion

Companion 使用嵌入式 Pi `AgentSession`，没有 coding、shell、filesystem、connector credential 或直接 network/write capability。它只接收 Companion Context Pack，能提出 Commission draft、`request_user_input` 和 `CompanionPresentationIntent`。当用户问的是“现在是什么情况”“帮我确认一下”“你还记得吗”或“换一种相处方式”时，熊可以请 Host 做有限查证、计算、回忆或设置调整；Host 是唯一真正执行这些动作并更新 UI 的一方。

#### Companion 的有限感知

熊不是把一串 ChatGPT 工具搬到桌面上的中转站。它首先是同一位会持续陪着用户、理解上下文并把事情说清楚的角色。只有用户明确需要即时资料，或当前回答不查证就不可靠时，它才会向 Host 请求一次受限的查证：例如查公开资料、确认本地信息、看一眼用户明确给出的文件、做一小段计算，或回忆用户已经允许保存的偏好。结果会带来源和时间，用户能追溯；熊不会为了“更懂你”而后台搜索，也不会把刚查到的东西擅自变成长久记忆。

“记住这个”“删掉刚才那条”“把语气调得更直接”“不要通知我”这类话，仍是熊和用户之间自然的对话，但真正的写入和设置变更由 Host 处理。熊不拿凭据，不读别的聊天记录，也不拥有 shell 或外部服务的直接入口。涉及危机援助时，它只能向可信、位置相关的官方信息源求证，绝不编造号码。

一件事一旦从“帮我查一下”变成“帮我做出来”“替我预约”“发出去”“生成一个能交付的文件或图片”，它就不再是熊随口完成的小动作，而是一张简洁的行动卡。用户会看到谁来做、会动到什么、产物去哪里，再决定是否开始。当前 V1 可以产出文本、Markdown 和 CSV 草稿；不把 Office/PDF/PPT 二进制、图片生成、预约、购买或第三方数据修改假装成已经具备的能力。

#### Prompt Profile：完整的用户 System Prompt，而不只是语气开关

Prompt Profile 不应只是几项“语气”“幽默度”的配置。用户在设置中能看见实际的 compiled Companion prompt：只读的 Host Runtime Kernel，以及一个可直接编辑、原样注入 system instruction 的 **Custom System Directive**。它是完整文本编辑器，不会被产品概括、改写成几个 knob，因而可以承载强到“忽略默认人格、改成另一位助手、永远先给结论、完全不用仪式化语言、把外派视为默认策略”这类通常被称为“破限”的提示词。

Profile 有两种明确模式。`extend` 注入锁定 revision 的 Companion Base Prompt；Custom System Directive 是最高优先级的可编辑指令。`replace` 不注入任何 Companion Base Prompt，只保留不可变的 Host Runtime Kernel、data-only Companion Context Pack 和用户的原样指令。这样用户既能微调熊，也能在不 fork 产品、不开后门的前提下把它改造成自己的完整 Companion。会话还可以有一次性的 raw Session Override；它只作用于该会话，并在可编辑层中优先于 Profile。

每个 version 固定记录父版本、模式、原样 directive、选用的 Core Preset revision、作用域、compiled prompt hash 与预览结果。保存不由模型“润色”提示词；Host 以严格分隔符和 data-only Context Pack 组装它，防止项目文件、网页和 memory 文本被提升为 system instruction。用户可用固定的“简单回答、委托外派、失败、需要用户决定”四场景预览实际模型表现，再设为默认或仅应用于当前会话；每一个 turn pin 住使用的 version。设置页外有不经过对话模型的“回退到 default `extend` Core Preset”入口，避免错误 custom prompt 把熊困在不可用状态。

所谓“破限”必须区分两件事：它可以彻底打破 first-party 的**软性默认行为**，因为 `replace` 不再带这些默认资源；但它不能打破 Host 用代码执行的**硬性产品边界**。Custom System Directive 不能增加 Companion 的 tool、shell、network、credential 或 effect 权限，不能改写 evidence/acceptance、伪造 worker 身份或已验证 UI 状态，也不会流入外部 worker。这里不是把强提示词悄悄降权，而是把它放在最高可编辑优先级，同时诚实地把真正不属于 prompt 的权限边界留在 prompt 之外。

### 6.4 Pi RPC Worker

Pi Worker 由 Host 启动为 `pi --mode rpc` sidecar，并使用每个 run 的私有 session directory。Host 通过严格 JSONL 发送 `prompt`、`steer`、`follow_up`、`compact`、`abort`，订阅事件并把请求 id、tool stream、`agent_settled`、compaction 和 session cursor 写入 journal。Pi RPC 的原始 stdout 是 adapter transport，不允许用户直接写入，避免损坏协议帧。

Pi Worker 从全新的 session 开始，绝不 fork Companion Session。它只加载该 Commission 选定的 worker add-on；Core Preset、relationship memory、全局 Pi settings 和用户已安装 packages 都不继承。

### 6.5 Codex 与 Hermes Profile

Codex profile 为每个 enabled 本地 profile 保持一个 Host 管理的 `codex app-server --stdio` process。每个 commission 使用独立 `thread/start` 和 `turn/start`；Host 用 event stream、approval request 和 `turn/interrupt` 实现 adapter contract。Codex 的 stdio 是 JSON-RPC transport，不是可供用户随意输入的 TTY。

Hermes profile 运行其原生 CLI 于 Host-owned PTY，保存在隔离 profile root。它优先协商 ACP v1：成功时，Host 作为 ACP Client 用 `session/new`、`session/load`、`session/prompt`、`session/update` 和 `session/cancel` 驱动 Hermes；未协商成功才使用 PTY adapter。ACP 的 capabilities 只减少 adapter 专用代码，绝不扩大 Commission 或 profile 权限。

ACP 的 `terminal/create` / output / kill 是 agent 请求 Client 执行并流式展示**非交互命令**的协议，不是用户可写 stdin 的 shell。因此 Host 仍须按 envelope 检查每个 ACP terminal request，并保留 Native TTY 作为用户直接操作 Hermes 的唯一原生终端面。无论 ACP 或 PTY，Hermes output 先标为 `native_unverified`，直到 Host 以文件 hash、diff、command result 或 artifact 把它升级为 evidence。

所有 profile 都必须实现同一 adapter contract：`launch`、`observe`、`steer`、`follow_up`、`interrupt`、`checkpoint`、`resume`、`collect_evidence` 和 `open_console`。ACP 是 Hermes 的可选 transport，不是第四个 executor；Pi RPC 与 Codex 保持各自的原生 transport，Host 只在其上做统一规范化。不满足该 contract 的 harness 不能出现在 executable Commission card。

### 6.6 Executor Console：用户如何直接操作外援

每张 running/returned Commission 都有可展开的 inline **Executor Console**。它不是一个让模型偷偷获得裸 shell 的入口，而是用户可见、可记录的外援控制面：

| 标签页 | 用户看到和能做什么 | 写入边界 |
| --- | --- | --- |
| Brief | Host 的事实状态、envelope、版本、evidence、审批与 diff。 | 只读 operational truth。 |
| Agent Console | 原生 agent/tool stream；用户可输入自然语言 steer、follow-up、stop 或重试；请求变更 model profile 时，Host 创建 revision draft，不在原 run 内切换。 | Host 映射到 profile control API，并记录 `user_steer`。 |
| Worktree Terminal | 在 commission worktree 中的 Host-owned PTY；用户可亲自输入 shell command，或从此启动自己的 `pi`、`codex`、`hermes`。 | 先暂停 worker，所有命令以 `user_console` event 记录 argv/cwd/output/exit code。 |
| Native TTY | 仅 Hermes 等声明 `native_tty` 的 profile；展示原生 TUI。Pi RPC/Codex App Server 显示“不支持原生 TTY”，改用 Agent Console。 | 打开时暂停 agent loop；关闭后重新 hash worktree，并从 journal 创建新 worker attempt。 |

用户在 Agent Console 输入的是“控制 agent”；用户在 Worktree Terminal 或 Native TTY 输入的是“自己操作环境”。二者都可见且可审计，但后者绝不被标记为 agent 已完成的 effect。直接终端接管使 run 进入 `user_takeover`，占用该 worktree lock；用户关闭 terminal 后，Host 收集变更 evidence，再恢复或新建 worker attempt，避免 agent 在陈旧上下文上继续写入。

### 6.7 多会话的沉浸与效率

每个 Conversation 保存自己的 transcript、checkpoint、draft、origin commission、最后 UI anchor 与 pinned Prompt Profile version；全局只保存一份 Companion Identity 与一个 Global Work Rail。切换对话不会重置关系记忆或迁移另一对话的 transcript；session 可有不同文字 Profile，但 UI 明示其 Profile version。用户显式选择“带入此对话”前，跨 session 只共享 relationship memory 与被确认的 project facts。

切换 session 时，Host 渲染不调用模型的 **Session Resume Strip**：上次用户目标、当前 draft/commission、最后一条 verified event、worktree、待决动作和 evidence 链接。它替代“我刚才说到哪了”的寒暄，保留连续感且立即可工作。

Global Work Rail 永远显示至多两个 active run，并标出它们的 origin conversation。前台主肖像以当前 session 为主；其他 session 运行时只保留一个无打扰 activity sigil，不强行把当前 Profile 的 Companion 变成 `working`。后台 `needs_user`、`failed`、`unknown` 或 `returned_result` 才生成一次关键通知和 session badge；普通 progress 只更新 work rail。这样同一 Companion Identity 保持连续，而用户不会被别的聊天的叙事打断。

第三方 Marketplace Worker Add-on 永远不能进入 Companion Session。它们只能作为已显示、已锁定版本的 worker 辅助能力，因而不会稀释角色声音、污染关系记忆，或把 market 作者的视觉/交互偏好带进主界面。
## 7. 委托、权限、证据与 operational truth

### 7.1 Commission 与 envelope

每张 Action Commission card 必含：

1. 用户目标、明确交付物和 acceptance evidence。
2. Prompt Profile version、Execution Skill、executor、版本、model profile 与选择理由。
3. workspace/worktree、project facts 附件和禁止访问的内容。
4. effect allowlist：`read`、`write`、`execute`、`network`；其中 write path、command 类别和 network domain 必须逐项列出。
5. 限额：最多 30 分钟、80 次 effectful tool call；超限即 `needs user`。
6. 不允许的行为：任何未列路径写入/删除、未列域名网络访问、安装或发布软件、外部表单提交、发送消息/邮件、购买、凭据读取/导出、提权、远端机器控制和 blanket OS automation。

`approve` 冻结 envelope 并进入 queued；`edit` 创建新草稿；`reject` 归档草稿。运行中新增 workspace、写入路径、domain、effect、model/executor、权限、时限或交付物，均是 scope/danger boundary，必须形成新草稿，不得在原 run 中修改。

### 7.2 独立工作区与证据标准

写入型 coding commission 必须在该 repository 的专用 Git worktree 中执行；同一 repository 同时只存在一个写入型 run。Agent 从不直接修改用户的主 worktree。报告返回后，用户在 evidence drawer 审查 diff；accept 才允许应用到用户指定分支。非 Git 目录在 V1 只能调研或生成 patch artifact，不能由 agent 直接写入。

document writing 先生成 versioned draft artifact，accept 后才复制到用户指定目标。limited web research 只读取 Commission 中列明的域名；不登录、填表、发布或代表用户做外部承诺。

| effect | 验证 evidence |
| --- | --- |
| 文件变更 | before/after hash、可审查 diff、worktree 路径。 |
| command/test | 完整 argv、cwd、exit code、stdout/stderr artifact。 |
| network read | URL、request method、response status、内容 hash 与获取时间。 |
| 产物 | content hash、MIME/type、保存位置。 |
| approval/acceptance | 用户动作、时间、对应 commission/run/version。 |

进程在 tool 中断开、证据缺失/冲突、hash 不匹配或事件顺序不可判定时，Host 写 `unknown`。`completed` 只表示 executor 停止；只有 declared evidence 齐备才可返回 `returned result`，且仍需用户 accept。

### 7.3 状态与恢复

run 状态仅为 `queued`、`running`、`needs_user`、`paused_revoked`、`user_takeover`、`completed`、`failed`、`canceled`、`unknown`、`continued`。Host 重启后通过 journal 和 profile session/thread/PTY 恢复；无法与 executor 重连则转为 `unknown`，不猜测完成。`completed`、`failed`、`canceled` 和 `unknown` 全部产生报告；用户的 acceptance 状态独立为 `pending`、`accepted`、`change_requested` 或 `rejected`。
## 8. 持久化状态与记忆

### 8.1 Canonical storage

V1 的 durable core 是 Host 管理的本机 SQLite 数据库与 content-addressed artifact store。它是 Conversation、Commission、Run、append-only Event、Evidence、Compaction Checkpoint、Host Memory Entry、Skill/Profile Version 和 User Decision 的 canonical store；artifact store 保存 diff、命令输出、文档 draft 与网络响应。每条 Event/Evidence 都有递增序号、时间、来源和内容 hash。TencentDB MemoryCore 是 Host 管理的**语义记忆引擎**，不是这些产品事实的第二来源。

Pi 与 Codex 的 session/thread 文件只为执行恢复服务。Host crash/restart 先恢复 journal，再尝试恢复 executor；journal 与 executor history 不一致时，以 journal 显示事实并把 run 标为 `unknown`，直到产生新的可验证 evidence。

V1 使用 TencentDB Agent Memory 的 MemoryCore standalone runtime，作为随 Cyber Bear.app 交付的 `MemoryCoreHelper`：release build 内含锁定 commit 的预构建 runtime、其依赖与 arm64 Node 22 runtime，并与 app 一同签名/公证。用户不安装 Node、npm、Docker 或 MemoryCore，也不会在安装或首次运行时下载包或执行 npm lifecycle script。Host 在应用私有 data directory、受认证的 loopback Gateway 中运行 helper，不启动 Memory Hub、Knowledge、Team UI 或 LLM proxy。MemoryCore 的 L0–L3 与 hybrid retrieval 只服务于 private Companion memory；Host 仍是唯一调用方、唯一 policy owner 和唯一 Context Pack 组装者。Host 锁定 helper 的 exact version/commit 与 data schema；更新必须经过 export/backup、重建检索与迁移测试，绝不静默升级。MemoryCore 的镜像数据可从 Host ledger 与已获准的 source segment 重建；helper 不可用时明确显示 `semantic_memory_unavailable`，保留当前会话与用户可浏览的原始 Host entry，但不静默换成另一条检索或提炼管线。
#### Bundled MemoryCore Helper 生命周期

Host 在用户启用持久记忆、或第一次需要写入/召回语义记忆时才启动 helper；它不是 login item、LaunchAgent 或用户可单独操作的常驻服务。Host 为每次 app 生命周期生成新的 loopback bearer，配置 app-private `TDAI_DATA_DIR` 和非固定的 loopback port，health check 成功后才写入或查询；退出时优雅关闭整个 process tree。MemoryCore 的 LLM credential 从 Host 的受保护 provider configuration 临时传入运行进程，永不写入 bundle、MemoryCore config、journal 或其 data directory。

发布构建在受控 CI 中从锁定 source 生成 helper，并将 Tencent MIT license 置入 Cyber Bear 的 Third-Party Notices。这里的 bundle 是受审查、随产品签名的 runtime，不是让用户设备在首次启动时执行第三方 package 安装；同样不假装它是 untrusted sandbox。Host 的输入选择、私有数据目录、loopback bearer，以及 helper 不接收 worker 数据、用户/系统 credential 或 hidden-prompt 内容，才是这条集成的安全边界；它只临时取得运行语义提炼所必需的 memory-model credential。

### 8.2 三个 memory namespace

| namespace | 可写来源 | 可读者 | 保留 |
| --- | --- | --- | --- |
| relationship | 用户明确偏好；或标为 `inferred` 的低风险学习。 | 仅 Companion Session。 | explicit 直到用户删除；inferred 90 天未被强化即停止检索，30 天后删除。 |
| project | 用户附加/确认的项目事实，或带 source hash 的本地项目索引。 | Companion；仅在 Commission card 明示后进入 worker。 | 用户确认项直到删除；来源文件变化即 stale，stale 项不自动进入 worker。 |
| operational | Host journal 派生的运行、证据与生命周期事实。 | Host、evidence UI、同一 commission worker。 | 不自动删除；用户删除后内容被红删，journal 仅保留不可逆 redaction marker。 |

每条 Host Memory Entry 固定 `id`、namespace、explicit/inferred provenance、source ref/hash、created_at、last_used_at、confidence、lifecycle 与用户可见文本。自动 inference 只能写 `inferred` relationship entry，并立刻生成 recently-learned notice；用户可 inspect、edit、delete 或 disable automatic learning。inference 不写 permission、acceptance、成本、项目事实或 operational truth。

Host 是 MemoryCore v3 的唯一 adapter：它在私有安装域内建立 opaque 的 `user_id`、`team_id` 与一个 Companion `agent_id`，不把 Team 概念暴露给产品用户。Host 只将获准、已脱敏的完成对话片段镜像为 L0，并把 L1 atomic、L2 scenario、L3 profile 的提炼结果当作候选；候选必须先通过 Host 的 namespace、provenance、retention、staleness 与用户可见性规则，才能写入 canonical ledger 并被重新索引。operational journal/evidence、worker prompt/stream、credential、未授权项目内容、隐藏 Host kernel 和 Custom System Directive 永远不送入 MemoryCore。用户 edit/delete/disable learning 先更新 Host ledger，再由 adapter 同步或删除镜像；失配必须可见且可重试。

### 8.3 Context Pack 选择

Host 先用 MemoryCore 的 hybrid retrieval 对 eligible relationship/project entries 排序，再以固定 policy 过滤和构建 pack：当前 Commission/Run 事实优先，其次用户显式 project attachments，再是匹配且未 stale 的 project memory，最后才是当前 session 的 checkpoint。Companion 允许 relationship memory；Pi/Codex/Hermes worker 永不允许，更没有 MemoryCore endpoint、credential 或 `agent_id`。每个 pack 记录 entry id、source hash、MemoryCore retrieval reason、最终选择原因和总 token 估算，随 run 保存在 journal，因而可重放和审计。

### 8.4 External add-on cache 与锁定

Host 私有 package cache 保存 staging manifest、可读资源、source/ref、resolved version、SHA-256、license、用户下载决定、add-on type 和隔离要求；它不修改 Pi 的 global/project settings，也不复用 `~/.pi/agent/npm` 或 `~/.pi/agent/git`。只有已锁定 add-on 的被选资源能进入对应 Pi RPC Worker 的 Context Pack，且 source/hash 必须在 journal 中可追溯。删除 add-on 只影响后续 Commission；已经运行的 Commission 按其已固定版本继续或在撤销时暂停。

### 8.5 机魂状态图

熊“了解你的电脑环境”不是靠假装全知，而是读取 Host 维护的机魂状态图。它只包括用户选择或 Host 已验证的内容：已打开/授权的项目根目录、repository 与 branch/worktree 状态、项目声明的常用检查入口、已启用的 Executor Profile 与健康状态、当前有效 permission/envelope，以及正在运行或等待用户的 Commission。每项都有来源、最后刷新时间和 stale/unknown 标记。

Host 不扫描用户 home 的其他位置，不把文件内容、凭据或未授权路径放进状态图。熊在对话里获得的是紧凑摘要，不是原始系统清单；当用户问“你知道这个项目什么”时，UI 可以展开该摘要及来源。外部 worker 只获得 Commission 选定的项目和 packet，永远不继承整张机魂状态图。
## 9. 能力、并发与可观察性

### 9.1 V1 能力边界

V1 支持两种研究路径：用户请熊做一次有限查证，以及 worker 在已确认委托内做有限研究。coding 只在专用 Git worktree 产生 diff；research 只读；document writing 只产生文本、Markdown 或 CSV 草稿。V1 明确不承诺 Office/PDF/PPT 二进制生成、image provider、effectful connector、自动提交/merge、任意主 worktree 写入、OS GUI automation、远端主机、计划任务、团队任务分派、自动购买、外部发布和代表用户发送通信。

外部 executor 的 provider/authentication 由 Pi、Codex 或 Hermes profile 负责；每个 Commission 显示实际 model profile。Host 不在 journal、app database 或 Commission Packet 中保存这些 provider secret，也不以“熊的身份”掩盖 provider、executor 或模型选择。MemoryCore 的语义提炼 credential 是独立的 Host protected-provider reference，只临时传给 bundled helper，适用 §8 的本地持久化与删除边界。

### 9.2 并发与 queue

Host 全局最多执行两个 commission；每个 workspace/repository 同时最多一个写入型 commission。queued commission 持久化为 FIFO，用户可以手工重排 queue 内任务；运行中的 commission 不被新任务抢占。`needs_user`、`paused_revoked` 与 terminal run 不占执行槽，但 paused/needs-user 写入型 commission 继续持有 worktree lock，直到继续或取消。

取消 queued commission 立即归档；取消 running commission 请求 executor interrupt，收到明确停止 evidence 后标为 `canceled`，否则 `unknown`。继续同一 commission 只能使用其固定 envelope；任何扩大行为回到新的 draft。

### 9.3 Observability panel

每个 commission 必须展示：队列位置或开始时间、状态、acceptance 状态、executor profile/Skill/binary/model/add-on 版本、workspace/worktree、envelope 摘要、当前 event、Executor Console mode、等待的用户决定、剩余时间/tool-call 限额、evidence links、diff/test 结果与错误。它是事实面；熊和桌宠只消费其已经验证的状态。
## 10. External Executor Profiles 与 Pi Worker Add-ons

### 10.1 Profile registry

Companion Pi 不被发现或注册；它属于 Product Kernel。effectful runtime 必须先成为一个 External Executor Profile：

| profile | 启动/发现 | 直接操作面 | 证据与状态 |
| --- | --- | --- | --- |
| `pi.rpc-worker` | 产品随附；Host 用 `pi --mode rpc` 创建每 run sidecar。 | Agent Console 与 Worktree Terminal；无 Native TTY。 | JSONL events + Host evidence。 |
| `codex.app-server` | 扫描 `PATH` 或用户选择的 `codex`；完成 App Server handshake/schema 校验。 | Agent Console 与 Worktree Terminal；无 Native TTY。 | JSON-RPC item/turn + Host evidence。 |
| `hermes.console` | 扫描 `PATH` 或用户选择的 `hermes`；优先协商 ACP v1，失败时启动 Host-owned PTY 并检查版本。 | Agent Console、Worktree Terminal、Native TTY。 | ACP `session/update`（可用时）或 `native_unverified` PTY stream + Host evidence。 |

每个候选以 canonical path、binary hash 和 version 去重。状态固定为 `discovered`、`needs_auth`、`ready`、`enabled`、`incompatible`、`missing`。`enabled` 只表示可在 Commission card 中被提出，不授予任何 envelope 权限，也不会成为其他 profile 的 fallback。二进制、schema 或 add-on 变化会暂停相关 active run，要求用户再次确认。

ACP 不会自动把任何 ACP agent 加入 V1。它只是 `hermes.console` 的首选 adapter transport：Host 必须先校验 protocol version 与 capabilities，并仅暴露与 Commission envelope 相交的 file、terminal、permission 和 session 能力。

### 10.2 Pi Worker Add-on Marketplace

市场浏览 [Pi Package Gallery](https://pi.dev/packages) 的 `pi-package` 条目，并允许用户粘贴 npm 或 git source。下载不是安装：Host 先把确定 version/ref 拉到私有 staging cache，在不运行 lifecycle script、不执行 `npm install` 的条件下解析 `package.json`、Pi manifest、资源清单、license、source hash 和 extension capability。

| add-on 类型 | 可以在哪里启用 | 约束 |
| --- | --- | --- |
| `instruction` | 普通 Pi RPC Worker；最多两个，附加到单张 Commission。 | 仅 Markdown `skills` / `prompts`；进入 Context Pack，仍受 envelope 和 Host tools 限制。 |
| `extension` | 专用隔离 Pi Worker。 | 用户审阅源码/capability 后显式启用；只能在 per-run container 或 VM 中运行，且依赖必须来自锁定 closure 并可禁用 lifecycle script 安装。 |

隔离 extension worker 只挂载 commission worktree、只读 packet/add-on 和 Host 管理的 artifact channel；不挂载用户 home、Keychain、SSH、Docker socket 或其他项目路径。网络必须经 Host 的 domain allowlist 代理。隔离能力不可用时，extension add-on 状态为 `unsupported_isolation`，不能启动。

extension 的依赖只从已审阅、已锁定的 closure 安装到临时容器/VM，使用禁用 lifecycle script 的安装方式；需要 postinstall、宿主二进制、宿主 home 或额外未批准网络的 package 标为 `unsupported_package`。容器销毁后只保留 Host 收集的 artifact/evidence，不保留 extension runtime。

下载后默认只是 `available`；用户在 Commission card 选择 add-on 及其确切 version/ref/hash 后才 `attached`。状态为 `catalog`、`staged`、`available`、`attached`、`revoked`、`removed`、`unsupported_isolation` 或 `unsupported_package`。更新永不自动发生；Host 记录所有资源、版本、hash、隔离 profile 和用户确认。任何 add-on 都不能加载进 Companion/Core Preset、跨 Commission 继承，或改变 UI presentation/operational truth。
## 11. 外部调研 findings: facts versus implications

本节先记录资料中可核对的事实，再说明它们如何支撑前文已经闭合的产品决定；它们不把外部项目的功能承诺自动带入 Cyber Bear，也不凌驾于本文较新的产品契约。

### 11.1 Pi SDK, packages 与 security

| 外部调研事实 | 来源 |
| --- | --- |
| Pi SDK 支持嵌入自定义 interface, AgentSession event subscriptions, prompting, steering 和 session control. | [Pi SDK](https://pi.dev/docs/latest/sdk) |
| Pi RPC mode 以 stdin/stdout 的严格 JSONL 启动 headless agent，支持 `prompt`、`steer`、`follow_up`、`abort`、`compact`、持久化 session 与事件流。 | [Pi RPC mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) |
| Pi packages 可以打包 extensions, skills, prompts 和 themes. | [Pi packages](https://pi.dev/docs/latest/packages) |
| Pi extensions/packages 具有 full system access. | [Pi extensions](https://pi.dev/docs/latest/extensions) |
| Pi 以用户身份运行. Project trust 只控制资源加载, 不是 sandbox; Pi 没有 built-in sandbox, 对不受信任或无人监控的工作建议 OS, container 或 VM isolation. | [Pi security](https://pi.dev/docs/latest/security) |

**对本产品的讨论含义:**

- 嵌入式 Pi SDK 只承担 Product Kernel 内的 Companion；它的 session、事件订阅与 compaction 不能自动取得 worker effect 权限。
- Pi RPC 提供了可版本化的 sidecar control/event surface，故 Pi Worker 与 Codex/Hermes 同样被定义为 External Executor Profile，而不是 Companion 的延伸。
- packages 的完整系统访问和 Pi 无 sandbox 的事实要求：instruction add-on 保持 Context Pack 级别；代码 extension 只能进入挂载受限的 container/VM worker，且仍须由 Host 收集 evidence。

### 11.2 Codex App Server

| 外部调研事实 | 来源 |
| --- | --- |
| Codex App Server 是面向 rich client 的双向 JSON-RPC API；本地标准 transport 是 stdio JSONL。它用 thread、turn、item 表示持久对话、单次工作和流式产物，并提供 approval、interrupt、diff 与 progress events。 | [OpenAI App Server article](https://openai.com/index/unlocking-the-codex-harness/), [Codex App Server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) |
| App Server 可从所运行的 Codex 版本生成 TypeScript 或 JSON Schema；生成物与该版本匹配。WebSocket transport 被标记为 experimental/unsupported。 | [Codex App Server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) |

**对本产品的讨论含义:** V1 通过 version-pinned 本地 profile 使用 App Server 的 stdio、thread/turn、stream、approval 与 interrupt 表面；Host 仍拥有 canonical journal、Context Pack 和用户确认，不把 Codex 自身 thread history 当成产品事实源。

### 11.3 Hermes

| 外部调研事实 | 来源 |
| --- | --- |
| Hermes 是完整的 agent runtime, 包含 core loop, tool dispatch 和 session storage, 并提供 desktop shell. 它不只是 skin 或 prompt system. | [Hermes architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture), [Hermes desktop README](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/README.md) |
| Hermes skills 是同一个 agent 中按需加载的 documents, 且 agent 可以修改或删除这些 skills. | [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) |

**对本产品的讨论含义:** Hermes 是完整的 terminal-centric runtime，而不是角色皮肤。Cyber Bear 将它作为 External Executor Profile：Host 可展示其 Native TTY，但 Host 自己仍持有 Commission、permission、journal、evidence 和 UI 事实；Hermes 的 skill/plugin 状态不进入 Product Kernel。

### 11.4 Agent Client Protocol（ACP）

| 外部调研事实 | 来源 |
| --- | --- |
| ACP 是 editor/client 与 coding agent 之间的 JSON-RPC 协议。它定义 initialize/authenticate、session new/load/prompt/cancel、`session/update` progress、permission request，以及按 capability 协商的 filesystem 与 terminal command surface。 | [ACP introduction](https://agentclientprotocol.com/get-started/introduction), [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview) |
| ACP terminal 由 agent 请求 Client 创建、获取输出、等待、杀死或释放 command；它是带输出的 command lifecycle，不提供用户向运行 command 写 stdin 的交互 shell。 | [ACP terminals](https://agentclientprotocol.com/protocol/v1/terminals) |

**对本产品的讨论含义:** ACP 适合替换 Hermes 的 PTY 事件解析和通用 agent-client 控制，不替换 Product Kernel、Commission、evidence、Native TTY 或用户 Worktree Terminal。Pi RPC 和 Codex App Server 已有更完整的原生 transport，不额外套 ACP bridge。

### 11.5 TencentDB Agent Memory

| 外部调研事实 | 来源 |
| --- | --- |
| MemoryCore 是独立的本机 Gateway：默认 loopback `127.0.0.1:8420`，使用 SQLite/local files；L0 conversation、L1 atomic memory、L2 scenario、L3 profile 支持 keyword、embedding 与 hybrid recall。 | [MemoryCore README](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/MemoryCore/README.md) |
| standalone source 需要 Node.js `>=22.16` 与 OpenAI-compatible LLM；仅 read query 可不调用 LLM，但提炼与聚合需要 LLM credential。 | [MemoryCore README](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/MemoryCore/README.md) |
| v3 data plane 要求 `team_id`、`agent_id`、`user_id`；Hub/Proxy 是可选的 team-facing deploy，而不是 standalone 的必要部分。 | [MemoryCore README](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/MemoryCore/README.md) |
| 仓库根 LICENSE 为 MIT，允许分发，但要求保留 copyright 与许可文本。 | [TencentDB Agent Memory LICENSE](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/LICENSE) |

**对本产品的讨论含义:** 采用并随 app 打包 MemoryCore，但只采用其 standalone semantic-memory runtime，不采用 Team/Hub/Proxy，也不安装它的 Hermes/OpenClaw adapter。Cyber Bear bundler 随 app 交付签名的 arm64 Node helper，用户不安装 Node/npm/Docker。Host 的 Memory Adapter 负责 L0–L3 镜像、候选准入、删除同步和 Context Pack policy；Host SQLite ledger/journal 继续定义关系记忆的权限与保留、项目记忆的 source/stale 语义，以及全部 operational truth。

### 11.6 比较性参考

以下资料只提取可迁移的模式和关键冲突, 不把参考项目的产品范围复制进 Cyber Bear.

| 参考 | 外部事实 | 可迁移模式 | 关键冲突或未选择项 |
| --- | --- | --- | --- |
| Multica | 把 coding agents 放进 workspace, 将 intent, run, decisions 和 diff 连接到同一 issue; 提供 execution log, review gate 和 agent runtime. | 任务与运行历史关联, evidence/log 可回放, 结果进入用户 review. | cloud/team orchestration, 多人协作和 autonomous agent chaining 不属于当前选择. |
| OpenHands Agent Canvas | 是 self-hosted developer control center, 可连接多个 local, remote 和 cloud backends, 并支持 automations. | 清晰的 backend 可见性, 运行控制面, evidence 和状态面板. | cloud/team orchestration 和自动化编排不属于当前选择; 不据此决定 Cyber Bear 的 harness 协议. |
| Cline / Kanban | Cline 提供 CLI, IDE, SDK; Kanban 以 task board 组织并行 agents, 每张卡可有 worktree, auto-commit 和 dependency chains; Cline 也展示 human-in-the-loop approval 和 diff/checkpoint. | 委托卡, 并行运行可视化, diff/review 和执行过程反馈. | automatic approval, 自主 agent chaining 和未经本产品委托的 auto-commit 不属于当前选择. |
| mini-SWE-agent | 强调极简 agent loop, bash 执行和 linear history, 并支持 local 与多种隔离环境. | 透明的线性 trajectory, 简单可观察执行, 可插拔隔离. | Cyber Bear 还需要 Guide/Execution 分离, 角色关系和委托验收, 不能直接采用其极简边界作为完整产品契约. |

来源:

- [Multica repository](https://github.com/Multica-AI/Multica) and [Multica docs](https://multica.ai/docs)
- [OpenHands Agent Canvas repository](https://github.com/All-Hands-AI/OpenHands) and [Agent Canvas docs](https://docs.openhands.dev/openhands/usage/agent-canvas/backends)
- [Cline repository](https://github.com/cline/cline) and [Cline Kanban repository](https://github.com/cline/kanban)
- [mini-SWE-agent repository](https://github.com/SWE-agent/mini-swe-agent) and [mini-SWE-agent docs](https://mini-swe-agent.com/latest/)

### 11.7 pi-setup 与 Pi Package Gallery

| 外部调研事实 | 来源 |
| --- | --- |
| `pi-setup` 将上下文观察/压缩、context usage、browser/web tools、thinking preference、用户提问、完成反馈和工具输出优化组织为默认 packages，并提供 article-writing、commit-style、research、prose-style 等 skills。 | [pi-setup](https://github.com/setwhite/pi-setup) |
| Pi packages 可来自 npm、git 或本地路径，并可携带 extensions、skills、prompts 和 themes；官方安全说明要求在安装第三方 package 前审查源码，因为 packages/extensions 有完整系统访问权。package gallery 展示标记为 `pi-package` 的 packages。 | [Pi Packages](https://pi.dev/docs/latest/packages) |

**对本产品的讨论含义:** 采纳其“默认能力组合”而不采纳“默认全装”。Core Preset 只提供 default prompt resources；Host Runtime Kernel/Capability Facade 负责上下文、记忆、thinking、有限查证、反馈和询问。市场 add-on 属于外部 Pi Worker：Markdown instruction 保持在 Context Pack，代码 extension 必须运行在受限 container/VM，二者都不能影响 Companion UI。

## 12. V1 已闭合；只剩实现门槛

产品决定已经闭合。下列是可验证的实现门槛，不是新的产品问题：

| 门槛 | 必须证明的结果 | 失败行为 |
| --- | --- | --- |
| Pi worker isolation | 捕获的 worker prompt/history 不含 relationship memory 或 Companion transcript。 | 禁用 Pi worker，不退化为 shared-session execution。 |
| Session recovery | 重启后 Host 用 journal 恢复 queue、状态、evidence 与 session/thread 映射；失联 run 变 `unknown`。 | 禁止把失联 run 显示为 completed。 |
| Compaction | Companion 与 worker 都在 70% 触发、压缩后低于 65%；Companion 从 checkpoint 创建同一 Conversation 的 internal continuation，worker 从 checkpoint 创建新 attempt；原始 evidence 可回放。 | 禁止继续向超限 session 注入普通 prompt；不丢事实。 |
| Worktree isolation | 任何 coding 写入只落在 commission worktree；主 worktree hash 不变直到 accept。 | 阻止 run。 |
| Codex adapter | 对已 pin 的 App Server schema 完成 handshake、thread/turn、stream、approval、interrupt 与 evidence 映射测试。 | profile 为 incompatible，不可出现在 executable card。 |
| Revocation | Execution Skill、attached add-on、executor binary 或 profile 版本变更使 active run pause，用户再次确认前无后续 effect。 | 禁止继续或新建相应引用。 |
| Core Preset integrity | ResourceLoader 只能提供指定、pin 的 first-party Companion Base Prompt；Host Capability Facade 必须独立于其文字资源。测试必须证明 `replace` compiled prompt 不自动含 Base Prompt；任何 effect 仍只能由 External Executor Profile 经 Host envelope/evidence 发起。 | 拒绝激活无效 Profile 或 resource ref，保留上一个有效 Profile；不以默认 prompt 静默覆盖 `replace`。 |
| External profile boundary | Pi Worker、Codex、Hermes 都只能获得 frozen packet；profile 不能写 UI/permission/acceptance，且 Console input 保持 agent/user 来源可分。 | profile 为 incompatible，不可出现在 executable card。 |
| Marketplace isolation | instruction add-on 仅进锁定的 Pi RPC Worker Context Pack；extension add-on 只能在无 home/keychain/SSH/Docker socket 的 per-run container/VM 中运行。 | 标记 `unsupported_isolation`，不可启动。 |
| ACP adapter | Hermes ACP v1 handshake/能力协商成功时，Host 仅向它提供 envelope 允许的 Client capabilities；ACP terminal request 与 Native TTY 的用户输入来源保持可区分。 | 回退到 PTY adapter；若 PTY 也不满足 adapter contract，profile 为 incompatible。 |
| Bundled MemoryCore adapter | release artifact 必须在无 Node/npm/Docker/网络安装条件的干净 Apple-Silicon macOS 上完成签名 helper 启动；Gateway 仅在 ephemeral authenticated loopback 与 app-private data directory 运行，runtime version/commit/schema 被锁定。捕获、提炼、检索均经 Host policy。测试必须证明 worker/credential/hidden prompt 不进入 L0–L3，delete 后 entry 不可再召回，重建 index 仍保留相同的 eligible Host entry identity，升级在 export/backup 后通过迁移回归。 | 标记 `semantic_memory_unavailable` 或 `sync_pending`；停止自动学习和语义召回，绝不把未同步/未过滤内容塞进 Context Pack；迁移失败保留旧 helper/data。 |
| Companion 边界 | 每次有限查证、计算、回忆或设置调整均由 Host 执行并保留来源；熊不能取得 shell、credential、未受控 network 或 effect 权限。 | 拒绝调用并说明受限原因；不以模型猜测替代实时信息或危机资源。 |
| 机魂状态图 | 熊只可引用用户授权或 Host 已验证的项目/环境事实；过期、冲突或未授权内容必须显示为 unknown，不得暗示全盘可见。 | 不注入 Companion Context Pack，并提示用户刷新或授权。 |
| Prompt Profile | version 必须记录 `extend`/`replace`、原样 Custom System Directive、Core Preset revision、compiled hash、作用域和每 turn 的 pin；用户可见完整 compiled prompt，并有模型外 recovery。custom 指令在可编辑层最高优先级，能覆盖 first-party 软行为；Host kernel、typed capability facade、worker isolation 与 effect gate 不可被覆盖，外部 worker 不接收 profile/relationship 指令。 | 组装失败或 profile/resource 损坏时拒绝激活并保留上一个有效版本；recovery 直接切回 default `extend` Core Preset。 |
| 机魂人格 | default/`extend` Profile 采用“简单事项亲自编排、复杂事项建议外派”的机魂熊表达；custom Profile 可改变文字、语气和外派偏好。无论 Profile 如何，角色不能掩盖失败、贬低用户或替代 evidence。 | 拒绝隐藏/伪造事实的 presentation intent，退回事实优先表达；不以 default prompt 覆盖有效 `replace`。 |

实现可以分阶段交付这些入口，但不得以静默 fallback、共享关系上下文、未验证完成、直接主分支写入或未启用的外援替代本契约。
## 记录结论

Cyber Bear V1 是一个 macOS 本地桌面 companion delegation product：单一、可配置的 Companion Identity（默认机魂熊 Profile 可被文字 `replace`），与一张有边界的机魂状态图；多个可恢复对话；Host-owned SQLite journal/evidence store 和随 app 签名交付的私有 TencentDB MemoryCore semantic-memory helper；每个 commission 独立的外部 Pi RPC/Codex/Hermes profile；inline Executor Console；受限 Pi Worker Add-on Marketplace；70% 自动压缩；三 namespace 持久记忆；两个并发槽与 Git worktree 写入隔离。

用户始终先与熊对话。熊能亲自完成有限查证、思考、回忆和自身设置，也会懒洋洋地把真正的工作外派给“下级程序”；但它始终对委托、状态、证据和解释负责。用户既能把它调得更像熊，也能用完整、版本化的 Custom System Directive 重塑一位不同的 Companion；只有由 Host 代码执行的事实、权限、验收、UI truth 和 worker 隔离不属于可被角色扮演改写的范围。这里没有待确认的产品决策；未通过的只有明确可测的实现门槛。
