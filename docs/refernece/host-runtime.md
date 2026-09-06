# Host Runtime

## 职责

`@bear-harness/host-runtime` 是本地产品内核，入口位于 [`packages/host-runtime/src/runtime.ts`](../../packages/host-runtime/src/runtime.ts) 与 [`packages/host-runtime/src/composition.ts`](../../packages/host-runtime/src/composition.ts)。它负责资源管理和领域写入，不拥有 Pi 会话内容。

主要模块：

| 路径 | 职责 |
| --- | --- |
| `src/host-event-loop.ts` | 角色资源路由、切换、退休和关闭的单消费者事件队列 |
| `src/companion/pi-runtime.ts` | 多个真实 Pi `AgentSession` 的 Registry、open 去重和显式路由 |
| `src/companion/session-catalog.ts` | 当前角色的 Session 成员、归档和删除编排 |
| `src/companion/pi-live-events.ts` | 把 Pi 原生事件加上 session id 并投给临时通道 |
| `src/companion/companion-store.ts` | Character / Display 的统一角色级状态机制 |
| `src/companion/state-schema.ts` | `x-scope` 与 Character/Display 结构验证 |
| `src/storage/layout.ts` | `system/characters/companions` 路径与安全组件 |
| `src/storage/companion-storage.ts` | system DB 与每角色 DB 生命周期 |
| `src/storage/bootstrap-recovery.ts` | 启动致命状态检查、数据库重建和可中断恢复 |
| `src/models/registry.ts` / `src/providers/` | 系统模型池、角色默认 route 和凭据边界 |
| `src/memory/` | 显式 Memory 与角色级 TDAI runtime |
| `src/external-agents/run-service.ts` | Run 生命周期、恢复、证据与结果交付 |
| `src/artifacts/` | 角色 CAS、Artifact 完整性和有界读取 |
| `src/security/` / `src/diagnostics/` | 审计、脱敏和角色级诊断 |

## 进程与角色生命周期

启动顺序：

1. 验证 `<dataRoot>`；
2. 打开 `system/settings.db`；
3. 解析并验证活动角色包；
4. 打开 `companions/<id>/runtime.db` 和该角色的 memory、Run、Artifact、audit/diagnostics，并建立进程内失效通知；
5. 创建 Pi Registry 与类型化 Dispatcher；
6. 恢复可恢复的 Run，确认不可恢复的控制器丢失；
7. 对外开放 IPC/HTTP。

每个请求在进入时绑定一个角色 runtime。角色切换后，新请求进入新 runtime；已经开始的请求继续使用原 runtime，结束后原 runtime 才关闭。Pi 请求本身不进入这个队列，不同 Session 仍由 Pi 并发执行。

删除一个角色 runtime 前，Host 必须只关闭属于该角色的全部 Pi handles、memory runtime、Run controllers 和数据库句柄。Host shutdown 等待已经路由的请求结束后关闭资源；`close()` 是幂等的终态清理。

## Pi Registry

Registry 内存只保留真实 handle、同一会话的 open promise、事件 unsubscribe/dispose 以及删除排他所需信息。它不保存 messages 或派生生命周期。

所有动作都显式传 `conversationId`：send、abort、navigate、edit、regenerate、continue、model route、rename、archive、delete 和 external result delivery。不同会话可以同时运行；改名不改变 UI active，归档不关闭无关会话，删除只处理一个目标。

原生 Pi 事件经过最小安全投影后进入 transient subscriber 集合。事件不落库；快照由对应 `AgentSession` 直接读取。生产事件与 `PiLiveSnapshot.version` 携带同一真实 Session 的 `{ instanceId, sequence }`，只用于传输排序；不是持久事件序列或执行状态。历史从原生 `conversation.history` 分页读取，不从 live event 回放重建。

Pi 0.84.3 的普通 user / assistant / toolResult `message_end` 先通知 subscriber，再由 `SessionManager.appendMessage` 追加真实 entry；该路径没有普通消息的 `entry_appended` acknowledgement。`CharacterRuntime` 将实际原生事件统一延后到 microtask 转发，保持事件顺序并越过同步 append 边界，使后续权威查询读到已追加内容。Host 不伪造 `entry_appended` 或 transcript；`agent_end.messages` 的重复内容不转发，持久消息仍通过 Pi branch 查询刷新。

`PiLiveSnapshot` 的 `isStreaming`、`isRetrying`、`retryAttempt`、`isCompacting` 直接读取原生 getters，streaming message、pending tools 和 steering/follow-up 队列同样读取真实 Session。事件提示刷新，不构成另一套 Host 会话状态机；Renderer 请求中的 busy/error 只属于临时展示，不是 Host pending-turn 状态或合成消息。

send、edit 和 correction 等待 Pi 的 `preflightResult` 接受后返回，而不是等待整轮回复或 memory capture 完成。correction 在真实分支导航后重新提交原用户内容，将反馈仅作为下一次回复的临时 guidance；preflight 失败时恢复原 leaf。请求接受不等于执行完成，后续进展与结果继续以 Pi 为准。

abort 绕过会话 mutation queue，不排在导航或 prompt preflight 后。它只取得目标已存在或正在打开的 handle，等待后再次核对该 handle 仍在 Registry；目标已关闭时不重新打开 Session。停止调用原生 `abortCompaction()`、`abortBranchSummary()` 和 `abort()`（含 retry backoff 取消），只作用于实际存在的原生 controller；不宣称能取消尚未建立 controller 的 preflight，也不虚构 Host cancellation token 或“已停止”终态。

## Session Catalog

Catalog 位于当前角色 `runtime.db`，只保存 Pi session id、角色 membership 和 archived timestamp。标题读取与搜索连接 Pi 的原生标题，不保存副本。

删除验证 Catalog 所有权并只排除目标 Session 的新请求；如果目标正在运行则先 abort，随后 close 句柄、释放订阅、删除精确 transcript、清理会话级 Character/Display 和关联数据，最后删除 binding。任一步骤重复执行都不会误伤其他 session。

## Character / Display

`host_state` 接收 Pi 提供的 `conversationId` 作为产品数据 scope key；调用期间验证 schema、作用域、声明 ID 与 revision，并在一个角色数据库事务内提交 Character 和 Display。调用结束后不保留 Pi turn/message/tool id，也不等待后续事件。

Character 顶层 child 恰好一个 `x-scope: global | conversation`，后代不能覆盖。重建文档时使用浅层分区组合；Display 只读取当前 conversation 分区。

## 存储

系统与角色数据库由不同 handle 管理。系统模型删除先清理每个角色数据库中的对应 route，再删除系统模型记录，不虚构跨 SQLite 文件事务，也不保留旧结构兼容路径。

启动预检只打开会阻止产品整体启动的持久化状态：系统库、当前角色包和当前角色库。数据库同时检查 SQLite integrity、foreign keys、必需 schema、单例/身份以及启动阶段会读取的 JSON。修复建立当前最终 schema，迁移可验证的行并让坏行回到默认值；新库完整校验并 fsync 后才替换目标，原始数据库及 sidecar 永不原地修改。角色包事务的恢复失败按角色隔离，不能因为一个非当前角色损坏而阻止默认或当前健康角色启动。

## Memory

`ExplicitMemory` 只响应用户明确的 remember/change/forget 意图，使用角色目录中的 `MEMORY.md`。TDAI runtime 使用系统 embedding 配置，但其 records/vector/index/checkpoint 全部在当前角色目录。切换 embedding 后每个角色独立重建。

打开真实 Pi `AgentSession` 时，Host 读取一次角色包稳定 Prompt、用户称呼和显式 `MEMORY.md`，组成该 Session 的稳定 system context。当前 Character/Display、按当前输入检索的 Canon 与 TDAI recall 通过 Pi `before_agent_start` 作为当轮临时 system context 注入，不写成 transcript message。Host 不做统一字符截断，也不实现第二套长对话摘要/压缩流水线；上下文窗口与 compaction 继续由 Pi 原生机制负责。

真实阶段通过 [`LivePush`](../../packages/protocol/src/schema.ts) 的 `conversationActivity` 临时通道报告：`memory_recall`、`context`、`memory_capture` 各次调用生成独立 `operationId`，发出 `started` 与 `completed` / `failed`，失败可附 `errorMessage`。每次通知都重新读取该 Session 的原生 `live` snapshot；这些标识只关联阶段调用，不是 Pi turn id。关闭关系记忆时不调用、不发送假的 recall/capture；context 只报告实际执行的上下文编译。

`memory_capture` 在 Pi `agent_settled` extension 中被 await。`CharacterRuntime` 按 Session 持有实际 capture promises，Session close 在 abort 后 drain，再释放订阅与 dispose；角色关闭先关闭 Pi handles，再关闭 memory runtime。capture 失败发送阶段失败通知，但不阻断原生 `agent_settled` 的继续交付。由于 extension 等待期间可能已有新一轮开始，迟到的旧 `agent_settled` 不能证明当前会话 idle；须刷新真实 Session snapshot，不能清除新一轮状态。

activity 不落库、不回放，也不建立持久 activity/state mirror。SQLite memory 使用自身 FTS 路径，不初始化仅供云端 TCVDB 使用的 BM25 sparse encoder。

配置的 store 初始化失败、降级或所需 reindex 未完成时，readiness 失败，不能标记 runtime 已启动。初始化失败会清理部分资源、移除失败的缓存 promise，后续调用可以重试。这里的 store readiness 不保证每次远端调用或本地 embedding warmup 都成功。

显式 memory/conversation search 将不可用或失败与成功零命中区分：只有实际成功检索才能返回 `[]`；无可用分支时报告 `memory_search_unavailable` / `memory_search_failed`。hybrid 的可用分支可以成功返回零命中，但失败分支必须留下降级诊断。自动 recall 可省略失败或超时的可选上下文，不阻塞主对话；省略不是“已确认没有记忆”。枚举/reindex 读取失败也不能伪装为完整空集合。

[`memory/diagnostics.ts`](../../packages/host-runtime/src/memory/diagnostics.ts) 的 `createMemoryDiagnosticsLogger` 由角色 runtime 注入，写入该角色 `diagnostics/memory.jsonl`，轮换为 `memory.previous.jsonl`，每份上限 256 KiB。仅记录时间、级别、白名单阶段/原因与归类后的操作/结果，不保存自由文本 query、记忆正文、路径、凭据或 provider 回复；写日志失败也不回退到全局原文日志。

## Runs 与 Artifacts

### Pi-only admission

新任务只能由 `host_delegate({ instruction, inputPaths? })` 交给内置 Pi Worker。模型不选择 agent；没有默认 executor 设置或自动 Codex fallback。现存 Codex discovery/settings/history 不等于新 admission 的可选后端。

Host tool wrapper 提供真实 `conversationId`、`triggerEntryId` 和原生 `toolCallId`，形成 `DelegateParams`。Run service 以 `conversationId + toolCallId` 幂等准入，不按 instruction 去重；校验会话成员、输入路径、`pi-default` profile、模型 route 与资源容量后持久化 Run。返回 `DelegateResult = { accepted: true, runId, executor: "pi" }` 只确认身份与准入，不声称仍处于 `enqueued` 或已经完成。

receipt 返回后，由 Run 拥有并跟踪的异步 launch 启动 executor；启动失败保留同一 Run ID，写失败证据与 `failed`。取消、删除会话和关闭会 drain/停止真实 admission、launch、control 与 delivery 资源，不能在已取消或删除后再启动。Pi 继续独占对话 transcript/streaming/history/native state；Host 独占 Run 生命周期、权限、workspace、证据与 Artifact 安全。

### 查询、证据与控制

`run.list` 默认返回当前角色全部未完成任务（`enqueued`、`running`、`needs_user`、可恢复的 `interrupted`）和一页最近完成历史；可按已验证归属的 `conversationId` 过滤。`scope: "unfinished"` 只返回未完成任务；`scope: "history"` 按 cursor 分页。新完成项不能挤掉未完成任务。`limit` 为 1–100，响应至多 200 项。`run.get` 按 Run ID 返回权威 Run、instruction、输入文件名及独立分页的有界脱敏 evidence；不返回内部 workspace/CAS 路径。

Pi Worker 的公共 assistant text 与原生 tool start/update/end、args/result/error 转为有界 ACP evidence，工具输出不改写为 worker 叙述，也不把进程 stderr 当任务成果。Run 的 compact evidence 至多 20 项，详细证据通过 `run.get` 按需读取。

`Run.controller` 为 `attached | unknown | confirmed_lost`；`actions` 来自真实 controller 能力与持久生命周期交集，而不是仅按 status 猜测按钮。`steer` 返回真实 `{ outcome: "injected" | "startedNewTurn" | "sent" }`，不代表指令完成。`interrupt` 等待原生暂停确认，`resume` 仅继续已确认暂停的同一任务，可附 instruction；`cancel` 必须停止/释放真实资源，不支持时失败。终态竞态不能被后到的控制结果覆盖。

Renderer 的 list/get/control 在当前角色内验证 Run 归属，不要求任务属于当前选中会话。模型的 `host_run_read({ runId? })` 与 `host_run_control` 额外限制为调用工具的会话；control 仅有 steer/interrupt/resume/cancel/retryDelivery，不能替用户批准权限。权限 RPC 校验真实 requestId 与 optionId。

启动恢复先 query/reattach：`unknown` 或 probe 失败不代表在线、不触发重新执行，也不写强制终止；只有 `confirmed_lost` 才将未完成 Run 写为 `forced_termination`。用户暂停的 `interrupted` 与控制器永久丢失不同，只有实际可恢复能力才允许 resume。删除遇到未知 controller 会失败关闭边界，而不是删掉仍可能运行的资源归属。

### 原会话结果交付

终态结果包含 Run ID 与 executor，按 `runId` 幂等交给 `run.conversationId`，与 UI active 无关。`PiRuntime.deliverExternalResult` 只在真实 SessionManager 已持久化匹配 `host_external_agent_result`、`details.runId` 的 custom-message entry 后返回 `{ entryId }`；随后 Host 才写 `resultReportedAt`。忙碌会话的 `sendCustomMessage(..., { deliverAs: "followUp" })` 返回只代表入队；闲置会话的 acknowledgment 也无需等模型解释整轮结束。

原生 subscriber 在 append 前触发，entry 查找延后到 microtask。去重依据是已持久化 entry 或真实 Session/Run 的在途 delivery promise/subscription；bounded timeout 不清掉仍在途的操作，也不再排一个副本。会话 disposal 负责清理该 Session 的操作。终态未确认投递时可用 `run.retryDelivery` 重试同一结果；仍 pending 则返回错误，不伪造 `resultReportedAt`。重试投递不会重跑任务，新执行仍必须走新的原生 delegation。

输出捕获逐项验证 containment、symlink、MIME、大小和 SHA-256，然后将字节写入当前角色的 CAS。Artifact 查询和动作验证 conversation、run、artifact 三层归属。open/reveal/save-as 由外壳提供原生 presenter；普通 Host API 不接受 Renderer 目标路径。

## 事件与查询

产品域变更只发进程内失效通知，不保存、不回放；审计单独写入审计日志。Run live envelope 为 `{ type: "run", companionId, run }`，角色标签防止切换后迟到事件污染新角色；Run 内含自己的 `conversationId`。重连重新查询权威数据，不回放 live journal。列表接口轻量且可分页；conversation、Run、Artifact 和 Character/Display 通过按 ID detail 读取。bootstrap 不扫描所有会话。

## 验证

```sh
fnm exec --using=.nvmrc npm run typecheck --workspace @bear-harness/host-runtime
fnm exec --using=.nvmrc npm run test:unit --workspace @bear-harness/host-runtime
fnm exec --using=.nvmrc npm run test:coverage --workspace @bear-harness/host-runtime
fnm exec --using=.nvmrc npm run test:release:recovery
```

核心测试应覆盖多 Session 并发与隔离、角色切换时的请求归属、原生流、显式结果路由、改名/删除、目录隔离、Artifact 归属/完整性、双层 onboarding 和 scope schema。
