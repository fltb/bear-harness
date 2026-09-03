# 31 项体验问题实施状态（WIP）

更新时间：2026-09-03

当前结论：31 项均已有对应实现落点，相关代码、单元测试、构建以及必需 Web/Desktop E2E 已完成本轮回归。本文件记录的是 WIP 功能完成与验证状态，不替代正式发布报告及其余发布门禁。

1. **主页归档入口** — 已从主页侧栏移除“已归档”入口，归档管理只保留在系统设置。实现位于 `packages/companion-ui/src/Sidebar.tsx` 与 `packages/companion-ui/src/features/SettingsSheet.tsx`。
2. **归档 tooltip** — 归档按钮现在明确提示“可在系统设置 → 已归档中查看”。文案与测试位于 `packages/i18n/src/locales/*`、`packages/companion-ui/tests/sidebar-journey.spec.tsx`。
3. **冗余对话模型设置** — 已删除系统设置中的对话模型页面、对应 workflow 和旧测试，不再把当前会话模型与系统默认模型混为一谈。模型切换只写 Pi 当前 Session route，不再顺手改系统默认回复模型。
4. **图片读取模型归属** — 多模态 fallback 现在只读取 installation-wide system vision default，不再按角色读取图片模型。实现位于 `packages/host-runtime/src/models/registry.ts` 与 `packages/host-runtime/src/character-runtime.ts`。
5. **系统模型页结构** — 系统模型页现在按“Provider 列表 / 添加 Provider / 新角色默认回复模型 / 安装级图片模型”分区。角色会话模型由 composer 管理，安装默认只用于新角色初始化。
6. **Provider 添加流程** — 添加 Provider 改为独立按钮打开的专用对话框，添加成功后自动关闭。内置候选、Pi 配置导入和自定义 Provider 均在该流程内完成。
7. **Provider 列表/添加组件混杂** — 已导出并使用独立的 `ProviderList` 与 `AddProviderForm` 展示面，不再把候选添加区长期塞在已有 Provider 列表里。OAuth 编辑错误也已修正为在所属列表组件内显示。
8. **工作代理内置项** — 工作代理页已删除无意义的内置 Pi 卡片，只展示需要用户管理的外部 Codex 连接。Pi 仍是产品内部的权威运行时，不作为可重复添加的工作代理呈现。
9. **重复 Codex** — Host discovery 只返回扫描顺序中的第一个有效来源：先取 PATH 中第一个，否则取第一个官方 fallback。UI 也只消费候选数组的第一项，禁止重复 Codex 实例。
10. **登录目录** — Renderer 和 RPC 已删除 `codexHome` 输入与字段，用户不再填写登录目录。Host 内部从 `CODEX_HOME` 或标准 `~/.codex` 推导，文件系统位置不由 Renderer 授权。
11. **网络代理不可操作** — 直连、系统代理、手动代理三种模式始终可选，不再错误地受 embedding capability 列表裁剪。保存中才禁用控件，恢复真实可操作性。
12. **角色设置 Canon** — 角色设置不再暴露独立 Canon Studio 标签页，避免把角色包内部 Canon 当成普通设置编辑器。角色设置直接进入角色包管理主界面。
13. **角色包仅开放 manifest** — 当前角色包编辑只开放 `character.yaml` manifest 的单一编辑面，不再并列暴露 prompt/storage 等多套权威入口。插件信任仍作为安全状态展示，不成为第二份角色配置。
14. **Schema 自动表单** — manifest 表单由 Host 返回的 JSON Schema 递归生成，支持对象、数组、布尔、数字与文本字段。编辑结果直接回写同一份 YAML draft，没有平行表单状态。
15. **系统文件夹打开按钮** — 角色包页新增“在系统文件夹中打开”，通过新 RPC `character.packageReveal` 请求 Host。Desktop 只接收已校验的角色 ID，由 Host 解析真实目录后调用系统 shell 打开。
16. **Schema 实际来源可疑** — Host 现在导出并实际执行严格的 Zod `CharacterManifestSchema`，加载角色包时先 `safeParse`，不再用 TypeScript 断言冒充验证。返回给 UI 的表单 Schema 由同一个 Zod schema 通过 `toJsonSchema` 生成。
17. **自己发送消息显示错误** — 乐观用户项把 spinner 与“发送中”状态分开，消息正文不再和加载中文字一起旋转。UI 只创建一个可识别的 optimistic user projection item。
18. **发送中消息丢失** — RPC 返回不再立刻删除临时用户项；只有对应 Pi user entry 出现在事件或权威 snapshot 后才原位交接。失败时同一项保留并提供重试，不另建第二条消息。
19. **回复时出现空消息** — `agent_start` 不再生成空 assistant bubble，只有非空 delta 或真实错误才进入时间线。瞬态流式项与最终 durable entry 通过 response/timestamp 交接，稳定投影不会同时显示两个空壳。
20. **一次“记住”重复出现两次工具更新** — 已删除消息操作中的“记住这一刻”按钮，切断会触发重复明确记忆的伪快捷入口。显式记忆追加同时具备内容幂等检查，未改变的工具结果不会重复渲染。
21. **明确记忆的定义/后台行为/模型理解错误** — `explicit_memory` 保持“仅在用户明确要求记住、修改或忘记时写 MEMORY.md”的边界，普通角色互动不再伪装成明确记忆命令。自动关系记忆仍由后台 TDAI 独立处理，不与明确记忆 UI 混用。
22. **角色回复内容失真** — 已移除会诱导角色自行解释记忆结果的“记住这一刻”普通消息路径，显式记忆工具只返回真实文件变更状态。角色稳定上下文继续由 Session 打开时的角色包、Canon 与 Explicit Memory 组成，不在 UI 伪造角色认知。
23. **角色按钮/选择器交互过重** — “这不像极昼”改为紧凑 popover：上方预设列表，底部为“其他”输入与提交按钮。点击外部自动收起，Enter 可提交，不再显示取消按钮和大型表单。
24. **编辑消息错误弹出表单** — 最新用户消息使用 `内容 | 编辑图标` 的原位编辑，textarea 直接替换当前正文。Enter 保存、Shift+Enter 换行、Escape 取消、失焦提交，不再另起表单面板。
25. **非目标消息也出现编辑/分支操作** — 历史消息只显示复制，编辑只允许最新用户消息，重新生成/纠正/fork 只允许最新助手回复。流式期间最新回复的变更操作也会隐藏，避免对不稳定 turn 操作。
26. **所有消息的无用三点菜单** — 已彻底删除消息右上角三点菜单和通用 operations fieldset。允许的动作改为直接、紧凑、按消息资格显示的图标或按钮。
27. **从此处新建对话是死按钮** — fork 直接调用 Pi 原生 `conversation.fork` workflow，并只在最新稳定助手回复上显示。执行失败会在原消息就地显示错误，不再无反馈。本轮真实 UI E2E 发现并修复了两处更深层问题：分支改为使用独立加载的 Pi manager，避免改写源 Session handle；Catalog 在构造新 Session 前预登记 ownership，失败时回滚记录并删除精确的新 transcript。
28. **切换对话丢模型** — `ConversationDetail` 现在携带该 Pi Session 的 `selectedModel`，激活会话和重连 snapshot 都会原子恢复 route query。切换 active UI conversation 不再覆盖、清空或借用另一会话模型。后台 E2E 使用两个不同模型 ID 并发发送、切换、重载 Renderer 后再次发送，四次请求均命中各自模型。真实模型旅程还发现并修复了启动竞态：默认会话的迟到 `open` 结果不再覆盖用户已经明确选中的另一会话。
29. **唯一用户乐观更新 + 实时 Pi 流式拼接** — `activeTimeline` 是单一投影：durable Pi entries、一个 optimistic user handoff、Pi 原生队列和一个 streaming assistant item。流式 token 实时渲染在同一个稳定 assistant 投影项中，durable entry 到达后接管而不是再添气泡。
30. **仅最近一轮允许重新生成/fork 等操作** — 时间线计算最新 user/assistant entry ID，并以此限制编辑、重新生成、纠正与 fork。历史 turn 不再暴露会改变分支的操作，只保留无副作用复制。
31. **缺失复制按钮** — 所有可见用户和助手文本消息均新增直接复制按钮，并提供“已复制”短暂反馈。复制不依赖三点菜单，也不会创建 Pi 状态或新分支。

## 当前验证状态

- 已通过：全仓 lint 与全仓 TypeScript typecheck。
- 已通过：全仓单元测试，包括 scripts 11 项、i18n 9 项、protocol 10 项、Host 421 项、Companion UI 153 项、Desktop 121 项、WebDev 4 项。
- 已通过：Desktop 与 Web 构建。
- 已通过：Web 必需 E2E 28 项，全部使用 Playwright 后台无头模式；包含系统/角色 onboarding、并发 Session、原生流式切换、真实 UI fork、双 Session 不同模型及重载隔离、External Run/Artifact、响应式结果区、重命名/归档/删除与角色连续性。
- 已通过：Desktop 源码 E2E 3 项，覆盖真实 Electron 启动、诊断与损坏设置恢复；本轮在 CI 后台隐藏窗口模式执行，没有打开前台测试窗口。
- 已通过：Host/Desktop 恢复套件 56 项。
- 已通过：使用当前本机 Pi/Codex 配置完成完整 live-model 套件 4/4。`gpt-5.6-terra` 覆盖真实回复 smoke，以及普通陈述不调用 `explicit_memory`、明确“记住”会调用该工具、后续角色身份仍为“极昼”；完整旅程同时使用 `gpt-5.6-terra` 与 `gpt-5.6-sol`，真实走过两个 Session 的不同模型路由、UI 会话切换、单一消息投影、复制、原位编辑并重生成、重新生成时的侧栏/停止按钮流式状态、原生 fork、分支继续回复、Renderer 重载和路由复核。密钥只在 Host 进程内注入测试 Provider，不写入日志或测试产物。
- 已通过：自然语言剧情 live-model E2E。用户只说“我想看看那条没归档的回报。别先给摘要，我想从原件开始查。”；模型必须自行读取生产角色 Skill，并在真实 Pi transcript 中产生 `host_state`、`host_media` 与 `host_choices`。浏览器验证“残缺报码”与“转发台登记”两张 CG 的打开/关闭和原生位置，验证“交接档案室 → 转发台资料室”背景、“极昼在核对”表情、模型生成的普通自然语言选择按钮，以及 `K-4`、`未获复述` 等权威剧情事实；同时明确拒绝未在资源中出现的 `06:40`、风向等补写。若模型没有主动给出选择，测试仅以自然语言追问现有方向，并要求该新回合实际调用 `host_choices`，不接受纯文字冒充交互卡。
- 本轮回归同时修复：合法连字符角色包 ID 的严格校验、阻断 traversal 角色 ID、角色包 reveal 的 Host 路径授权、显式记忆幂等、Pi fork 源句柄隔离与 Catalog ownership 时序、Renderer 启动默认会话迟到结果覆盖用户选择的竞态、调试 RPC 选择状态、可选 theme 默认、乐观用户消息在权威 settled snapshot 后的交接，以及已经移除/改版页面对应的陈旧 E2E 契约和视觉基线。真实剧情测试另外发现并修复两处系统问题：章节更新后必须重新读取新 chapter 唯一 eligible 的剧情资源，禁止用 Canon/常识补写；活动 Session settle 后 UI 同时刷新权威 Conversation 与 Character/Display 状态，避免 Host 已切换场景但背景仍停留在旧值。
- live-model 探索记录：一次以 `gpt-5.6-luna` 作为第二模型的并发请求返回了空白 assistant 内容；`gpt-5.6-terra-pro` 虽出现在本地清单，但当前账号组返回不支持；`sol/terra` 探索运行还遇到过上游 502 或工具后长时间不 settle。测试不会把这些情况计为通过。随后正式完整套件以 `gpt-5.6-terra` 为主模型、`gpt-5.6-sol` 为第二模型完成 4/4，这些现象作为当前模型端点兼容性/稳定性观察保留。
- 尚未声明正式发布：覆盖率阈值、安全审计/签名、全平台新鲜打包及同一 clean commit 的 packaged smoke 仍需按发布流程单独执行。

## 证明索引

以下证据与上面的 31 项一一对应；“真实模型”只用于模型行为，不替代可重复的系统验证。

| 项 | 主要实现证明 | 自动化证明 |
|---:|---|---|
| 1–2 | `Sidebar.tsx`、`SettingsSheet.tsx`、i18n 文案 | `sidebar-journey.spec.tsx`；Web 设置/侧栏旅程 |
| 3–5 | `SettingsSheet.tsx`、`ProviderSetup.tsx`、Host model registry | `model-settings-contract.spec.tsx`；onboarding、rule-provider E2E |
| 6–7 | 独立 `ProviderList` / `AddProviderForm` 与添加对话框 | Provider UI 单测；三尺寸视觉 E2E |
| 8–10 | `Backstage.tsx`、External Agent RPC/Host discovery | External Agent Host/UI 单测；Web backstage 旅程 |
| 11 | `NetworkAndMemorySettings.tsx` | `network-memory-settings.spec.tsx`；Host proxy tests |
| 12–16 | `CurrentRolePackageManager.tsx`、严格 `CharacterManifestSchema`、`character.packageReveal` | character loader/draft/import、protocol schema、composition reveal 测试；角色包视觉 E2E |
| 17–19 | `companion.tsx` 的 optimistic/durable/streaming 单一投影 | composer/UI 单测；chat streaming E2E |
| 20 | 显式记忆内容幂等与 `changed:false` 隐藏 | `companion-state-store.spec.ts`、`tool-activity.spec.tsx` |
| 21–22 | `explicit_memory` 工具边界与 Session 稳定上下文 | 真实 `gpt-5.6-sol` live-model E2E：普通陈述不写、明确请求写、角色身份保持 |
| 23–26 | `ConversationPanel.tsx` 紧凑纠正、原位编辑、资格过滤、移除三点菜单 | `message-versions.spec.tsx` 与三尺寸视觉 E2E |
| 27 | PiRuntime 独立 manager fork、Catalog ownership 预登记/失败回滚 | `pi-runtime.spec.ts`、`session-catalog.spec.ts`、真实 UI fork 后台 E2E |
| 28 | Session snapshot 的 `selectedModel` 恢复；迟到的启动默认 `open` 只能在仍无 active Session 时激活 | 延迟回包竞态单测；两个真实模型/Session 的切换与重载 live-model E2E；确定性并发 E2E |
| 29–30 | 单一 `activeTimeline` 与 latest-entry 资格计算 | streaming/edit E2E；`message-versions.spec.tsx` |
| 31 | 所有文本消息直接复制及反馈 | clipboard mock 精确断言复制正文；`message-versions.spec.tsx` |

受“不启动前台 E2E”的约束，系统文件夹 reveal 没有真的弹出 Finder；已验证 Renderer 不能传路径、协议拒绝 traversal ID、Host 只解析角色包可信路径，以及 Desktop 将该可信路径交给系统 shell。这个限制不影响路径授权逻辑的证明，但不把“肉眼看到 Finder 窗口”伪报为已测。
