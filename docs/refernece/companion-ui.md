# Companion UI

## 边界

`@bear-harness/companion-ui` 是 SolidJS Renderer。它通过 `CompanionClient` 读取和修改 Host 产品域，并直接投影 Pi snapshot/live events。它不读取 Host 数据库、Pi transcript、角色目录或内部 CAS。

入口位于 [`packages/companion-ui/src/App.tsx`](../../packages/companion-ui/src/App.tsx)，主要 store 位于 [`packages/companion-ui/src/stores/companion.tsx`](../../packages/companion-ui/src/stores/companion.tsx)。

## UI 可以拥有的状态

- 当前角色范围内的 task selection；active conversation id 则读取 Host authoritative Query，不是窗口本地业务状态；
- 输入草稿、焦点、tab、search 文本；
- 当前选择的 Run/Artifact 与结果 workspace 开关；
- 短生命周期 preview Blob URL 和本地 loading/error presentation；
- dialog/drawer/fullscreen 的交互状态。

UI 不拥有 messages、streaming、queue、tool execution、Character、Display、Run 或 Artifact。它可以对权威值进行响应式分组和展示计算。Host-backed 业务状态不做 optimistic update：mutation 成功后只采用 Host response 或刷新后的权威 Query；草稿、busy/error 和展示选择可留在 UI 本地。

## 启动与查询

1. bootstrap 读取安装级信息和 system onboarding 状态；
2. 读取当前角色及 character onboarding；
3. 获取轻量 conversation list；
4. 获取 Host authoritative active conversation detail；用户显式切换后采用 Host 返回的 active projection；
5. 读取该 conversation 的 Character/Display detail；
6. 订阅 process-local transient invalidation 与 Pi live stream；invalidation 只是 cache hint，没有持久化、cursor 或 replay 契约。

客户端绝不在 bootstrap 中遍历每个会话。detail 按 active/需要展示的资源读取。连接状态区分 `connecting`、`connected`、`reconnecting`；订阅建立后读取 Host authoritative snapshot，完成替换才进入 `connected`。重连会清除旧 live/activity/tool projection，以新的 detail/snapshot 恢复，不让重连前晚到的请求或旧事件覆盖新投影。

## 多 Session 与流式显示

每个 Pi event 带 session id。store 为相应 conversation 更新 token 文本、tool activity、queue、error 和 settled projection；窗口切到另一个 conversation 时，后台的原 Session 继续运行和接收事件。

发送、abort、edit、retry、navigate、continue 与模型选择都传明确 conversation id。UI 按 conversation 保留 send/edit/correct 的短生命周期 submission presentation：`submitting`、`accepted`、`failed`、`unknown`。`submitting` 期间禁用重复提交；RPC 成功就结束 submitting，`accepted` 不代表模型回复已完成。这不是 Host pending-turn 状态，也不伪造 Pi transcript。

已 accepted 的请求恢复只刷新权威投影；结果 unknown 的 edit/correct 同样只刷新，不重复触发可能已付费的生成。刷新本身不能证明 unknown edit/correct 的请求结果，因此不能将其冒充成功。send 的重试复用原 `clientMessageId`，而不是创建一个新请求身份。

执行、自动 retry、compaction、tool execution 与 queue 只由 Pi native snapshots/events 决定，Pi 仍是会话执行的权威；Host 另行拥有 External Run 生命周期。首段正文尚未出现时也展示真实 native activity。队列分别标明 `steering`（引导当前执行）与 `followUp`（当前执行后的跟进），不合并成一种“发送中”状态。

Host 的真实 `conversationActivity` notices 单独展示 `memory_recall`、`context`、`memory_capture` 的 started/completed/failed 阶段，并携带当时的 native live snapshot。它们不是新执行状态；记忆处理与模型回复执行并不等同，回复结束后仍可能有 memory capture。Stop 只在 native `live.isStreaming` 为 true 时显示，不为尚不可取消的 recall/context preflight 提供虚假停止按钮。

## Native 内容与历史

- 工具行保留真实工具名与由实际参数提取的简短摘要。原生 partial toolCall 参数在 `tool_execution_start` 前即可显示，此时仅标记 presentation-only 的“Preparing call / 正在生成调用”，不冒充工具正在执行；实际执行后的 running/completed/failed 由 native 状态决定。默认折叠的可访问 disclosure 展示参数、原生 content/details 和错误；未知工具不被改名为笼统的“内部操作”，未改变内容的记忆工具结果也不隐藏。
- 工具以 session + native toolCallId 保持参数生成 → 执行 → 持久化的 disclosure 身份，保留原生 entry id 供历史导航。`host_media`、`host_choices` 的原生结果旁保留媒体/选项交互，`host_delegate` accepted receipt 旁展示相应 Run 卡片；这些控件不替代原始结果的可检查性，同一 Run 不再重复生成 fallback 卡片。
- live 与 settled 使用同一安全内容投影：文本、受支持的内嵌图片、可见 custom message、bash execution、branch/compaction summary、模型与 thinking-level notice。失败回复保留已生成正文与 native error。`display:false`、内部 extension 数据、opaque signatures 和 redacted thinking 不作为公开正文显示。
- 不注入原始 HTML，也不自动请求远程跟踪图片；不支持或过滤的公开内容有明确说明与安全 source disclosure，不伪装成成功渲染。
- 更早历史由显式“加载更早历史”入口读取 native `conversation.history`，呈现 loading/error 并保留滚动锚点；不是回放持久化 live-event journal。snapshot/event 的 session instance + sequence 与读取/分支 generation 防止旧事件覆盖新 snapshot；已加载前缀仅在原生 ancestry overlap 证明同分支时保留。

## 双层 onboarding

System Onboarding/Settings 负责 provider、credential、configured model pool、系统默认模型、网络、embedding 与本地模型下载。

Character Onboarding 只展示角色第一次见面、关系选项、角色包首次选择，以及从系统模型池选择的角色默认 route。关系记忆由成功配置 embedding 启用，不另设角色级 consent 开关。缺少系统能力时，角色流程暂时打开 System Settings；完成后继续角色流程，已存在角色不会重做系统设置。

## Character / Display 投影

角色 store 只订阅当前 conversation 的统一 Character/Display snapshot。场景、表情、媒体、choice 和其他 presentation 都由这条路径派生。choice click 仍然是普通用户输入，走与手写文本相同的 send path；没有专属命令协议。

Run、Artifact、permission 和 Pi live state 从各自来源读取，不拼入 Character/Display。

## Current work、历史与任务详情

Current work 专指当前角色跨会话的 External Runs，与模型回复、工具、retry、compaction 及记忆阶段的 activity presentation 分开。未完成列表包含 enqueued、running、needs_user、interrupted，不因新的完成项挤出仍在进行的任务；terminal history 分页加载。任务详情仍在同一工作面板，不新增全局任务页面。

任务选择属于当前角色，切换会话不隐式清除，切换角色才清除。详情按 Run ID 查询，展示真实状态、controller attached/unknown/confirmed_lost、最近实际活动、instruction、声明输入、summary/error、Artifacts 与有界分页 evidence。没有 Artifact 的 Run 仍可查看状态、证据和可用动作；不捏造进度百分比，也不将终止/取消等同成功。

控制只按 Host 返回的 `actions` 提供：steer、interrupt、resume（可附继续指令）、cancel、permission response 与 retryDelivery。permission 展示原始 option name 和授权类型/范围；UI 保留各动作的 busy/error/draft，不自行判定控制器能力。steer 的 injected/startedNewTurn/sent 是真实接收方式，不等于任务完成。controller unknown 不冒充仍在线或自动重新执行。

新委派只使用内置 Pi Worker，没有模型可选 agent、默认执行器设置或 Codex fallback。`host_delegate` 的 accepted receipt 包含 Run ID 与 executor `pi`；Host 用 conversationId + native toolCallId 幂等接纳，再启动其跟踪的执行资源。接纳不等于工作完成，后续启动失败仍归属该 Run。

Run 终态与结果回报是两件事：`resultReportedAt` 只在原会话持久化了匹配的 native custom-message entry 后成立，follow-up enqueue 不算已送达。retryDelivery 重试原 Run 的结果回报，不重新执行；“请求再次执行”是用户显式发送到原会话的普通消息，新执行仍须经过 Pi 委派。

后台进展或完成不抢焦点、不切换会话、不自动打开任务详情或结果。查看另一会话的 Artifact 只在用户明确点击后先完成 Host 会话导航，再选择结果。

## 独立媒体与结果 workspace

角色媒体在原生 `host_media` 结果位置显示缩略图/播放入口，点击打开独立媒体 viewer。CG 保留构图，支持展开与原始尺寸查看；媒体不是 Run evidence，也不按图片 MIME 混入 Artifact。打开或关闭媒体不关闭已有结果区，这些展示选择不写 Character/Display 或影响 Pi 执行。

Run/Artifact 使用自己的成果按钮。用户选择后，UI 以 `{conversationId, runId, artifactId}` 打开 conversation-owned 结果 workspace：

| 宽度 | 组件行为 |
| --- | --- |
| `>= 1600px` | 导航之外为 conversation 与 result preview 两个主体；常驻大立绘让位，不额外挤出第三窄列 |
| `768..1599px` | right-side overlay/drawer |
| `<= 767px` | full-screen result view |

切换 active conversation 清除旧 Artifact 选择；character-scoped task selection 与此独立。关闭 workspace 恢复普通会话布局。结果 workspace 不因继续聊天或点媒体入口的普通 outside interaction 自动关闭。

## Artifact 预览与动作

metadata、provenance/evidence 和 corruption/unavailable error 都来自 Host。安全 text/image/PDF/audio/video 预览通过有界 chunk 组合 Blob URL；切换或关闭时立即 revoke。

open、reveal、Save As 调用 ID-only RPC。Desktop 交给原生 presenter；WebDev 提供浏览器安全 preview/download，unsupported native 动作应明确呈现，而不能猜测 CAS URL。

## 响应式与可访问性

- 主 UI 必须在上述三个 breakpoint 验证，不以桌面最小宽度掩盖布局问题。
- 非手机布局在扣除导航及相邻结果预览后的主区域内，左右各留 `24px`，剩余宽度按展示区/对话区 `40:60` 分配；没有吸收剩余宽度的右侧空列或固定聊天宽度上限。
- 窄主区域优先保留对话区 `480px`，先压缩展示区；不足 `480px` 时对话占满可用宽度。标题、消息列表、输入框共享水平边界；手机仍为单列、消息与输入框左右各 `12px`。
- 短消息气泡按内容收缩，长消息可使用所属消息列的全部宽度，不再给用户气泡增加 `2/3` 上限。背景按视口等比铺满并保持位置，不随对话长度伸长。
- 对话是 live region；tool/run/artifact rows 有稳定语义与键盘入口。
- drawer/dialog/fullscreen 管理焦点回收、Escape 与可访问名称。
- 媒体使用真实 MIME 和可用 captions；文本以 DOM text 呈现，不注入 HTML。
- 产品文案来自 `@bear-harness/i18n`；角色文案来自验证后的角色包。

## 验证

```sh
fnm exec --using=.nvmrc npm run typecheck --workspace @bear-harness/companion-ui
fnm exec --using=.nvmrc npm run test:unit --workspace @bear-harness/companion-ui
fnm exec --using=.nvmrc npm run test:coverage --workspace @bear-harness/companion-ui
fnm exec --using=.nvmrc npm run test:e2e:web:required
```

人工验收还要真实点击系统设置、角色 onboarding、并发两个 Session、流式切换、后台 Run 完成、Artifact preview/download、三个结果 breakpoint 以及 rename/archive/delete/restart recovery。

README 中的现有截图已从真实隔离 WebDev 重拍：`conversation.webp` 为 `1440×850`，`conversation-mobile.webp` 为 `390×1100`，`media-preview.webp` 为 `1440×850`。回复来自预先编写的 loopback provider，媒体入口来自实际 `host_media` native tool result；这不是 live-model 验证、文件修改证据或发布就绪证明。完整浏览器、下载、控制和发布门禁的结果另见开发验证记录，截图不替代这些验收。
