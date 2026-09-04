# 主对话路径 UI 发布前审计报告

更新时间：2026-09-04

## 结论

主对话路径的富内容阻塞项已经实现并通过确定性测试、后台浏览器 E2E 和真实模型验收：稳定回复与流式回复共用无状态 `MessageContent`，支持经过净化的 GFM、代码高亮和 KaTeX；角色稳定上下文也已加入自然的 Markdown/代码/公式表达约定。

当前仍不建议直接进入正式发布候选。Composer 自动增高、阅读位置保护、辅助技术播报范围、触屏操作尺寸以及完整的字体/动效收敛尚未完成。本文保留首次审计发现，并在已经完成的条目上标记修复状态。

## 本轮实施更新

- 已完成：稳定与流式 assistant 回复统一走纯展示 `MessageContent`；组件只消费上层响应式属性，不持有会话数据。
- 已完成：GFM 标题、强调、列表、引用、表格、代码围栏与语法高亮；KaTeX 行内/块公式；原始 HTML和 Markdown 图片不进入展示结果，最终 DOM 统一净化。
- 已完成：角色产品级响应约定鼓励在自然需要时使用 Markdown，并规定代码围栏、公式定界符、原始 HTML 与选择按钮边界。
- 已完成：Pi 事件按 `conversationId` 分会话投影；切换会话不终止其他会话；权威快照替换后回放请求期间到达的瞬态事件。
- 已完成：长流式回放把同一消息连续更新折叠为最新状态；10,000 次更新的回放队列保持 2 项，消除原先的平方级消息副本增长。
- 已完成：`agent_end.messages` 不再跨 Host→UI 边界传输，前端回放层也拒绝保存；记忆仍在 Host 内从 Pi 权威 Session 读取。
- 已完成：离开非流式会话、归档、删除和切换角色时释放会话详情、Character/Display、模型路由、工具瞬态、失败乐观项、完成标记与旧角色 Run 缓存；删除后的迟到事件不能复活会话。
- 已完成：Run/权限操作状态缓存上限为 32；复制反馈每条消息最多一个计时器并在组件卸载时清理。
- 已完成：Desktop Artifact presenter 的 `dispose()` 现在等待已经启动的旧展示目录清理，已释放实例不会再继续删除随后创建的目录。
- 已完成：Pi 原生工具 start/update/end 进入分会话瞬态投影；权威快照携带 `pendingToolCallIds`，刷新或重连可恢复运行中工具提示。
- 约束证明：本轮实现未新增正则，也没有自建 Markdown 检测器或 HTML 转义器；解析与净化交给通用库。

## 审计范围与方法

- 范围：新建对话、输入、发送、乐观消息、流式回复、停止、稳定消息、复制、编辑、重生成、分支、工具/媒体/选择卡及长内容滚动；不审查设置页。
- 尺寸：1280×720、1920×1080、390×844。
- 数据：隔离的 WebDev 数据目录和可控 OpenAI-compatible 流式 Provider，不读取或修改用户真实会话。
- 富内容样本：标题、粗体、斜体、链接、无序列表、引用、GFM 表格、TypeScript 代码围栏、行内代码、行内公式、块公式和长中文段落。
- 流式样本：分四个 chunk、每段间隔 700ms；另做一轮长输入与“用户阅读上文时新 token 到达”测试。
- 源码核对：消息投影、Composer、滚动副作用、排版 CSS、动画 CSS、角色包和 Playwright 配置。

## 发布阻塞项

### P0-1：缺少统一的 Markdown/富内容渲染层（已修复）

稳定消息在 `ConversationPanel.tsx` 中直接渲染为 `<p>{text}</p>`，流式消息也使用相同的纯文本 `<p>`。浏览器实测一条富内容回复最终只有 1 个 `p`，而 `h1..h6`、`ul/ol`、`table`、`pre`、`code`、`a` 全部为 0。

实际表现：

- `#`、`**`、`*`、反引号、代码围栏、表格分隔线、链接目标和 LaTeX 定界符全部原样显示。
- 链接不可点击。
- 标题、列表、引用和表格没有语义结构，也没有视觉层级。
- 代码使用正文宋体，没有语法高亮、代码块背景、横向滚动、语言标签或单独复制。
- 公式既不排版，也没有失败降级状态。
- 稳定消息与流式消息虽然都失败为纯文本，但至少暂时保持了一致；后续实现必须继续共用同一渲染路径，不能形成两套内容权威。

证据：`packages/companion-ui/src/ConversationPanel.tsx:240`、`packages/companion-ui/src/ConversationPanel.tsx:428`。

### P0-2：角色没有 Markdown 输出契约（已修复）

全仓角色配置和稳定上下文没有 Markdown、代码围栏、公式、表格或富文本输出规范。极昼只被要求“先给结论”“现代、简短的中文”和直接可核验表达。结果是模型可能偶尔自行输出 Markdown，也可能使用纯文本、全角编号或自创排版；UI 无法据此形成稳定产品体验。

应补充角色无关的产品级输出契约，而不是把具体 UI 语法散落到某个剧情 Skill：

- 普通短回复优先自然段，不为形式强行加标题。
- 两项以上并列结构可用列表；真正的矩阵数据才用表格。
- 代码必须使用带语言标识的围栏；文件路径、命令和标识符使用行内代码。
- 数学内容明确使用支持的行内/块公式定界符。
- 不输出原始 HTML，不用 Markdown 伪造按钮；选择仍只能来自 `host_choices`。
- 角色表演动作和技术内容的排版规则应分开，避免“角色感”污染代码和证据。

证据：`config/characters/jizhou/character.yaml:85`，以及全仓角色配置未检出 Markdown/公式输出规范。

## 高优先级可用性与功能问题

### P1-1：长输入框不会自动增高

Composer 固定 `rows={1}`，没有自动高度逻辑，CSS 同时设置 `resize: none`。移动端输入 8 行后，实测 textarea `clientHeight=44px`、`scrollHeight=224px`，用户一次只能看到约 1–2 行，只能在小框中内部滚动，难以复核长 prompt、代码或多行上下文。

建议：1 行起步，随内容自动增长至桌面约 8 行、移动端约 6 行或既定 `dvh` 上限；超过上限后才内部滚动。增长时保持发送、附件和模型按钮稳定，不遮挡 thread。

证据：`packages/companion-ui/src/Composer.tsx:116`、`packages/companion-ui/src/styles/thread.css:138`。

### P1-2：流式更新会强制抢走用户的阅读位置

当前滚动副作用在时间线变化时无条件执行 `scrollTop = scrollHeight`，没有“用户是否位于底部附近”的判断，也没有“回到底部/有新消息”提示。

浏览器实测：在第二轮回复开始后把 thread 滚到顶部，`scrollTop` 为 0；下一个流式更新到达后自动跳到 575.5，用户被强制拉回底部。

建议：

- 仅在用户发送消息、或当前距离底部小于约 48–80px 时自动跟随。
- 用户主动向上滚后进入 detached 状态，新 token 不再改 scrollTop。
- 显示“回到最新”按钮和未读增量提示；点击后恢复跟随。
- 会话切换、重载和编辑/重生成后分别定义可预测的定位规则。

证据：`packages/companion-ui/src/lib/dom-effects.ts:10`、`packages/companion-ui/src/ConversationPanel.tsx:528`。

### P1-3：发送中与模型已开始回复可短暂同时出现

第一轮 900ms 截图中，用户气泡仍显示“发送中”，同时助手气泡已经出现正文和“正在回复”。这会让用户误以为请求尚未送达，尤其在网络慢或发生重试时难以判断真实状态。

建议以 Pi 权威 user entry 到达作为乐观消息交接点；助手 `message_update` 已出现时，用户项不应继续显示发送中。为该顺序增加可控事件测试，不以最终 settled snapshot 掩盖瞬态错误。

### P1-4：整个对话容器使用 `aria-live="polite"`

流式文本在同一个 `<p>` 中持续变化，而整个 thread 是 live region。辅助技术可能在每个 token/chunk 到达时重复宣读大段内容，稳定消息、工具卡和错误也混在同一个播报范围内。

建议把对话历史移出 live region；只提供一个窄的状态播报节点（“极昼正在回复/回复完成/回复失败”），稳定完成后按产品可访问性策略播报一次新增消息摘要。流式正文不应逐 token 宣读。

证据：`packages/companion-ui/src/ConversationPanel.tsx:536`。

### P1-5：触屏操作目标偏小且操作依赖 hover

- 复制/编辑图标为 24×24px，默认透明，仅 hover、focus-within 或 focus-visible 时出现。
- 重生成、纠正、分支按钮实测高度 32px。
- 这些尺寸低于常用的 44×44px 触屏目标；触屏没有可靠 hover，复制/编辑的可发现性弱。

建议移动布局下让常用操作可见或由明确的“消息操作”按钮展开，触控目标至少 44px；桌面可以保留 hover 渐显，但键盘焦点和高对比模式必须清晰。

证据：`packages/companion-ui/src/styles/interaction.css:76`、`packages/companion-ui/src/styles/interaction.css:104`。

## 中优先级视觉与动效问题

### P2-1：消息字号规则存在层叠冲突

`thread.css` 把正文定义为 `font-serif text-lg`，后加载的 `refinement.css` 又把 `.msg p` 改成 `text-base`。浏览器最终值为 16px/26px，而不是前一层声明表达的 18px 意图。`.msg` 本身也先后经历 `text-xs` 与 `text-sm` 覆盖。

这会让字号调整依赖样式表顺序，难以建立稳定的 typography scale。建议合并消息排版所有权，明确区分：角色正文、用户正文、元信息、工具状态、代码、表格、公式和操作按钮。

当前实测：

- 助手正文：宋体 16px，line-height 26px。
- 窗口宽度下正文可用宽度约 423px；全屏下约 544px；移动端约 241px。
- 所有原始代码和公式也继承宋体 16px/26px，技术内容辨识度差。

证据：`packages/companion-ui/src/styles/thread.css:34`、`packages/companion-ui/src/styles/thread.css:56`、`packages/companion-ui/src/styles/refinement.css:452`、`packages/companion-ui/src/styles/refinement.css:493`。

### P2-2：主对话动效语言不完整

当前可见动效主要是：

- 多处相同的 0.75s 旋转 spinner；
- 角色 thinking/listening 的持续漂浮或轻旋；
- 场景/角色图片首次 reveal；
- 少量工具 trace 入场。

消息气泡、流式首 token、完成 settle、错误、停止、编辑替换、重生成版本切换和新选择卡没有统一的入场/状态过渡。结果是背景角色持续运动，而用户真正关注的文本状态主要靠 spinner 和突然出现/消失表达，注意力层级倒置。

建议建立克制的 motion tokens：

- 首 token：80–120ms opacity/translate，不对每个 token 做动画。
- stable handoff：保持同一几何位置，无二次入场。
- 工具/媒体/choices：120–180ms，遵循同一 easing。
- stop/error：颜色和图标即时变化，不做庆祝式位移。
- 角色 thinking 动画幅度降低，并避免与阅读中的长回复持续竞争。
- 保留当前全局 `prefers-reduced-motion` 禁用机制，这是现有正确项。

证据：`packages/companion-ui/src/styles/interaction.css:27`、`packages/companion-ui/src/styles/interaction.css:707`、`packages/companion-ui/src/styles/visuals.css:56`、`packages/companion-ui/src/styles/layout.css:443`。

### P2-3：模型选择器主路径文案可能重复

隔离 Provider 的 Composer 显示为 `UI Audit Provider (UI Audit Provider)`。当模型 label 与 Provider 描述相同，会形成重复文案并挤压移动端宽度。应定义稳定显示规则，例如“模型名 · Provider”，相同字段去重，辅助名称放 tooltip 或二级文字。

### P2-4：长回复是一个巨型气泡，缺少阅读导航

移动端富内容样本形成约 804px 高的单一助手卡；动作区只能在最底部看到。Markdown 完成后仍建议控制段落间距、标题层级、代码块最大高度，并考虑长回复的“复制全文”固定入口或轻量回到顶部/底部能力。不要把每个段落拆成独立 Pi 消息或建立第二份 transcript。

## 现有正确项

- 稳定消息和流式消息都来自 Pi 投影，没有为富文本另建持久状态。
- 停止回复按钮在 streaming 时替换发送按钮，语义清楚。
- IME composing 时 Enter 不会误发送；Shift+Enter 保留换行。
- 文字与当前深色消息背景的基础对比度充足；本次测得正文对比度约 13.6:1，次级操作约 5.5–7.2:1。
- 长字符串使用 `overflow-wrap:anywhere`，没有造成页面横向溢出；但代码块实现后应改为代码区横向滚动，不能继续任意断词。
- 移动端无页面级横向溢出，Composer 与 thread 都在 390px viewport 内。
- 已有全局 `prefers-reduced-motion` 规则，后续新增动画必须继续受其约束。

## 建议实现边界

新增一个纯展示的统一 `MessageContent` 层，由稳定 assistant 消息与 streaming assistant 投影共同调用：

1. 输入只接受 Pi 当前消息文本和 `streaming/settled` 展示状态，不保存消息副本，不写 SQLite，不改变 Pi transcript。
2. 支持安全的 CommonMark/GFM 子集：段落、标题、强调、列表、引用、链接、表格、分隔线、行内代码和 fenced code。
3. 默认禁用原始 HTML，URL 做协议白名单；外链使用安全的打开策略。
4. 公式使用明确的 KaTeX/等价安全渲染器，禁用信任型命令；解析失败显示原始源码但不破坏整条消息。
5. 代码高亮器作为直接依赖显式引入，语言未知时降级为纯代码；稳定后高亮，流式期间可使用轻量样式以减少重排。
6. 流式阶段必须容忍未闭合强调、代码围栏、表格行和公式定界符；settled 后用同一 renderer 得到最终结构。
7. 复制整条消息复制原始模型文本；代码块另提供“复制代码”，不能把高亮 DOM 文本当 transcript 权威。
8. 渲染层只解释文本展示，不把 Markdown 链接、伪按钮或 fenced JSON 变成 Host 命令。`host_choices`、Media 和 Artifact 继续走各自原生工具结果。

## 必须新增的验收测试

### 确定性组件测试

- CommonMark/GFM：标题、强调、嵌套列表、引用、链接、表格、分隔线。
- 代码：已知/未知语言、超长行、缩进、空代码块、复制代码、代码中的 HTML 字符。
- 公式：行内、块级、连续公式、非法 LaTeX、安全命令限制和降级。
- 安全：原始 HTML、`javascript:`、data URL、事件属性、畸形链接、超深嵌套和超大输入。
- 流式切片：分别在 `**`、反引号、代码围栏、表格行、链接和公式中间断开，验证不崩溃、不重复节点、settled 后结构正确。
- 稳定/流式 parity：相同完整文本在两种投影下最终 DOM 结构一致。
- Composer：1–8 行自动增高、达到上限后内部滚动、IME、Shift+Enter、移动端软键盘高度。
- 滚动：位于底部时跟随；用户上滚后不抢位置；“回到最新”恢复跟随；切换 Session 不串位置。

### 后台浏览器 E2E

- 在 1920×1080、1280×800、390×844 检查完整富内容 fixture。
- 流式期间截取至少三个阶段，验证气泡位置稳定、无空泡、无重复消息、无整卡闪烁。
- 用户阅读上文时持续流式，断言 scrollTop 不被改写并出现新消息提示。
- 代码块横向滚动不带动整页；表格在窄屏有局部滚动或既定折叠方案。
- 键盘完成发送、停止、复制、代码复制、编辑、重生成和分支；移动端验证 44px 触控目标。
- 专门的 motion E2E 不应使用全局 `animations: disabled`；分别验证正常动画和 reduced-motion。现有视觉快照配置会禁用动画，只能证明静态布局，不能证明动效质量。
- live-model 只验证模型会在自然任务中合理选择段落/列表/代码/公式，并验证 renderer 没有改变语义；解析与安全正确性仍由确定性测试证明。

证据：`apps/web-dev/playwright.config.ts:41` 当前视觉截图默认禁用动画。

## 建议执行顺序

1. 统一 `MessageContent`，完成 Markdown、链接与基础语义结构。
2. 加代码块、复制、安全策略和超长内容性能边界。
3. 加公式与流式未闭合语法容错。
4. 修 Composer 自动增高和滚动跟随策略。
5. 修发送/回复状态交接与 aria-live。
6. 统一字体、字号、间距和触屏操作尺寸。
7. 建立消息/工具/角色状态 motion tokens 与专门动效测试。
8. 用真实模型做自然任务验收，再跑全部发布门禁。

## 发布决定

当前决定：**富内容与会话投影修复通过本轮工程验收，但主对话 UI 整体仍不通过正式发布审查**。

P0 已解除。正式发布前仍需完成 P1-1 至 P1-5 的实现和自动化证明，并补齐滚动、Composer、可访问性与专门动效 E2E。P2 可以分批精修，但字体层级和动效规范至少要先收敛为单一可维护规则，不能继续依赖后加载样式覆盖。

## 本轮验证结果

- lint、全仓 typecheck、全仓 build：通过。
- 全量单测：747 项通过；Host 422、Companion UI 170、Desktop 121，其余协议/国际化/仓库门禁 34。
- 后台 Web required E2E：30/30 通过；最终对话专项后台复跑 6/6 通过。
- 真实模型 E2E：使用当前 Pi/Codex 配置的 `gpt-5.6-terra` 与 `gpt-5.6-luna`，五条能力路径均通过；覆盖基础应答、角色与显式记忆边界、原生会话旅程、自然剧情的 CG/场景/表情/选择、自然富内容及刷新恢复。最终提交后的完整套件为 4/5，剧情首轮遇到一次上游零 token `Upstream request failed`；同提交单项重试后剧情 1/1 通过，失败被保留为外部模型服务证据而非隐藏。
- UI 覆盖门禁：statements 83.90%、branches 70.43%、functions 84.27%、lines 86.32%，通过声明阈值。
- Host 覆盖：statements 77.66%、branches 64.77%、functions 79.23%、lines 80.97%，通过该包声明阈值。
- 已知仓库级残留：Desktop 覆盖结果 statements 78.73%、branches 66.49%，低于其 80%/70% 声明阈值，因此根级 coverage 不能记为通过。此次审计发现并修复的 presentation dispose 竞态已连续两次专项通过，Desktop 全套 121 项也通过。
