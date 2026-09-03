# 31 项体验问题实施状态（WIP）

更新时间：2026-09-03

当前结论：31 项均已有对应实现落点，前端单元测试已通过（27 个测试文件、150 项测试）；Host、协议、桌面构建和 E2E 仍在最终回归，因此本文件随 WIP commit 提交，不作为发布完成声明。

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
27. **从此处新建对话是死按钮** — fork 直接调用 Pi 原生 `conversation.fork` workflow，并只在最新稳定助手回复上显示。执行失败会在原消息就地显示错误，不再无反馈。
28. **切换对话丢模型** — `ConversationDetail` 现在携带该 Pi Session 的 `selectedModel`，激活会话和重连 snapshot 都会原子恢复 route query。切换 active UI conversation 不再覆盖、清空或借用另一会话模型。
29. **唯一用户乐观更新 + 实时 Pi 流式拼接** — `activeTimeline` 是单一投影：durable Pi entries、一个 optimistic user handoff、Pi 原生队列和一个 streaming assistant item。流式 token 实时渲染在同一个稳定 assistant 投影项中，durable entry 到达后接管而不是再添气泡。
30. **仅最近一轮允许重新生成/fork 等操作** — 时间线计算最新 user/assistant entry ID，并以此限制编辑、重新生成、纠正与 fork。历史 turn 不再暴露会改变分支的操作，只保留无副作用复制。
31. **缺失复制按钮** — 所有可见用户和助手文本消息均新增直接复制按钮，并提供“已复制”短暂反馈。复制不依赖三点菜单，也不会创建 Pi 状态或新分支。

## 当前验证状态

- 已通过：`@bear-harness/companion-ui` 单元测试，27 个测试文件、150 项测试。
- 已通过：本轮分别执行过 protocol、host-runtime、companion-ui TypeScript typecheck；最终全仓 typecheck 尚待 WIP 后继续复跑。
- 进行中：Host 单元测试、协议生成目录清理、Desktop/Web 构建、必需 E2E 与完整 lint。
- 提交边界：极昼角色内容及其连续性测试是工作区原有/并行改动，不纳入本 WIP commit。
