# Protocol / Schema

## 责任

`@bear-harness/schema` 提供共享的 Zod 约束工具；`@bear-harness/protocol` 在 [`packages/protocol/src/schema.ts`](../../packages/protocol/src/schema.ts) 定义 RPC、响应包、领域类型、临时失效通知和 Pi 临时事件。这里是跨进程数据形状的唯一来源。

协议只保证形状、范围和枚举；领域所有权、路径 containment、凭据授权和内容哈希仍由 Host handler 验证。

## 通道类型

RPC 与临时更新不能混为持久事件日志：

| 类型 | 用途 | 持久性 |
| --- | --- | --- |
| RPC | 有界查询与命令 | 每次请求/响应 |
| 产品失效通知 / `LivePush` 产品投影 | 刷新角色产品数据，如 Run、Character/Display | 仅当前进程/连接，不落库、不回放 |
| `LivePush` Pi event / conversation activity | 原生流与真实上下文/记忆阶段 | 仅当前进程/连接，不落库、不回放 |

Pi live envelope 是 `{ type: "pi", conversationId, event, version? }`，不是 `sessionId` 字段；Run envelope 是 `{ type: "run", companionId, run }`。Run 内的 `conversationId` 标识所属会话，外层 `companionId` 标识角色，不能按 UI active 猜测归属。审计独立持久化，不是可重播的 live 通道。重连依赖权威查询覆盖本地投影。

## RPC 领域

当前接口按所有权组织：

- bootstrap/system onboarding/settings/providers/models/embedding；
- character package、character onboarding、Character/Display；
- conversation Catalog list/activeGet/select/create/open/history/rename/archive/delete；
- 明确 `conversationId` 的 message send/abort/edit/correct/switchVersion/continue/branch，以及模型 route；
- explicit memory、automatic memory settings、canon/story；
- character-scoped Run list/get/steer/interrupt/resume/cancel/respondPermission/retryDelivery；
- Artifact read/open/reveal/saveAs（摘要来自 Run）；
- diagnostics、audit 和更新。

conversation detail 与 Character/Display detail 按当前会话读取；bootstrap 不含所有会话的完整状态。列表返回轻量摘要，字节和证据由 detail/read 接口按需获取。

## 会话与流式类型

`conversation.open` / `activeGet` 的 detail 来自原生 Pi snapshot，包含 `branch`（activeLeafId、latestLeafIds、entries、hasMoreBefore）和 `live`，Host 不另存 transcript。`conversation.history({ conversationId, beforeEntryId?, limit? })` 返回 `{ entries, nextCursor? }`，limit 为 1–100、默认 50；历史源是原生 branch，不是 live journal。message mutations 始终带目标 conversation id；send 返回空响应，只确认请求接受，不确认整轮完成。

Pi transient event 支持至少：

- `message_start` / `message_update` / `message_end`；
- tool execution start/update/end；
- queue update；
- agent/turn start/end/settled；
- entry appended、session info、compaction/retry 等 Pi 原生信号。

`PiSessionEntry`、`PiAgentMessage`、`PiAgentSessionEvent` 使用原生 Pi 类型并校验 wire serializability，不改成另一套 Host 消息 schema。可显示的原生 args/content/details/result/error 保持工具身份和证据；安全投影移除凭据、内部路径和 opaque thinking signatures，而不是把所有工具内容降为通用摘要。Pi 0.84.3 普通消息的 `message_end` 先于持久 append，且没有普通 `entry_appended` acknowledgment；不能等待或伪造该事件作为 send 接受信号。

`PiLiveSnapshot` 直接投影 `isStreaming`、`isRetrying`、`retryAttempt`、`isCompacting`、streamingMessage、pendingToolCallIds、steering、followUp 与可选 errorMessage。snapshot 和 Pi live envelope 的可选 `version` 为 `{ instanceId: string, sequence: nonnegative safe integer }`；生产路径始终附加真实 Session 的传输版本，用于拒绝旧投影，不是持久生命周期、heartbeat 或 replay cursor。

## Run 与 Pi-only delegation

Run 保留八种 status：`enqueued | running | needs_user | completed | failed | cancelled | interrupted | forced_termination`。`interrupted` 的暂停资源可以仍未完成；不能仅凭该 status 当作丢失 controller。Run 包含 id、conversationId、triggerEntryId、executorProfile、title、artifacts、compact evidence，以及可选 summary、permission、startedAt、completedAt、resultReportedAt、controller、actions。compact evidence 最多 20 项；Artifact 摘要最多 1000 项。

`controller` 为 `attached | unknown | confirmed_lost`；`actions` 为 `steer | interrupt | resume | cancel | respondPermission | retryDelivery` 的适用集合。schema 允许二者省略，但 Host 生产投影根据真实资源和持久生命周期填充；省略不是支持能力的承诺。没有执行百分比、合成 heartbeat 或默认 executor 字段。

### 查询与 mutation

| RPC | 请求 | 成功响应 |
| --- | --- | --- |
| `run.list` | `{ conversationId?, scope?: "unfinished" \| "history", cursor?, limit? }` | `{ runs: Run[], nextCursor? }` |
| `run.get` | `{ runId, cursor?, limit? }` | `{ run, instruction, inputPaths, evidence, nextCursor? }` |
| `run.steer` | `{ runId, instruction }` | `{ outcome: "injected" \| "startedNewTurn" \| "sent" }` |
| `run.interrupt` / `run.cancel` / `run.retryDelivery` | `{ runId }` | `Run` |
| `run.resume` | `{ runId, instruction? }` | `Run` |
| `run.respondPermission` | `{ runId, requestId, optionId }` | `Run` |

Run RPC 的 runId 长度为 1–64，cursor 为 1–256，limit 为 1–100；控制 instruction 为非空且最多 12000 字符。list/get 是 query，其余是 mutation。Host 在当前角色验证所有 Run ID；可选 conversationId 也必须属于该角色，不要求等于当前选中会话。

list 默认返回全部未完成资源拥有者和一页最近完成历史；`unfinished` 不受新完成项挤占，`history` 独立分页。响应最多 200 项，nextCursor 指向更早历史。未完成集合超过服务容量边界时报错，不能悄悄截掉。get 的 evidence 按 createdAt/id 倒序独立分页，最多 100 项，每项 `{ id, kind, createdAt, data }`，data 为有界可序列化 JSON、编码长度不超过 65536；instruction 最多 12000 字符，inputPaths 实际投影为输入文件名，不是可读写路径授权。

`RunPermission` 携带 prompt、requestId、runId 和真实 options `{ optionId, kind, name }`；不另造 scope 字段或替换 option 名称。steer receipt 只描述 adapter 接收方式，不宣称执行成功。interrupt 等真实暂停，resume 仅继续可恢复任务，cancel 必须实际停止资源；未知或不支持的能力返回错误。恢复只有确认 controller 丢失才写 `forced_termination`，unknown 不自动重跑。

### 原生工具准入与结果确认

`host_delegate` 是 Pi 工具，不是额外 Run-create RPC。模型参数只有 `{ instruction, inputPaths? }`（instruction 1–12000；至多 10 个绝对输入路径）。Host wrapper 注入 conversationId、triggerEntryId、原生 toolCallId，服务以 `conversationId + toolCallId` 幂等准入，返回工具成功 payload `{ accepted: true, runId, executor: "pi" }`。receipt 先于受 Run 跟踪的异步 launch；后续启动失败保留该 Run 与失败证据。新任务只使用 `pi-default`，没有 agent selector、默认 executor 设置或 Codex fallback；现有 externalAgent discovery/status 接口不改变此边界。

`host_run_read({ runId? })` 读取调用会话的 bounded list/detail；`host_run_control` 按 runId 执行 steer/interrupt/resume/cancel/retryDelivery（steer 必须带 instruction，resume 可选）。模型工具还验证调用会话归属，不暴露 respondPermission。工具失败保留 `{ ok: false, code, message }`，Pi 原生 tool_result hook 将其标为工具错误，而不是成功正文里的失败字符串。

`resultReportedAt` 只在原会话已持久化匹配 Run ID 的原生 `host_external_agent_result` custom-message entry 后写入。follow-up 入队、模型解释完成与交付确认是不同边界。delivery 按 Session/Run 的真实在途操作或已持久化 entry 去重；等待超时不再排重复副本。`retryDelivery` 只重试同一终态结果，不重新执行；未确认持久 entry 时返回 pending 错误，不报告成功。内部 `PiRuntime.deliverExternalResult` 返回 `{ entryId }`，它不是 Renderer 可伪造的确认 RPC。

## Memory 阶段与失败

`LivePush` activity 为 `{ type: "conversationActivity", conversationId, operationId, activity, status, live, errorMessage? }`：activity 是 `memory_recall | context | memory_capture`，status 是 `started | completed | failed`，errorMessage 最多 4096 字符。operationId 仅关联一次真实阶段，不是 Pi turn id，不保存或回放。通知携带原生 live snapshot；迟到的旧 capture/settled 不能清除新一轮原生状态。

配置的 memory store 初始化/所需 reindex 失败不能报告 ready；失败 promise 清除后允许重试。显式检索失败或 unavailable 与成功零命中 `[]` 不同；hybrid 可用分支成功仍须记录其他分支降级。自动 recall 允许非阻塞省略，但错误/超时可观察，不能解释为已经验证没有记忆。Host 将有界、白名单化诊断留在当前角色 diagnostics 内，不向全局日志输出 query、正文、凭据或自由文本 provider 错误。

## Character / Display

Character schema 的根不声明 scope；每个直接 child 必须声明且只能声明一次 `x-scope: global | conversation`；任意后代声明 scope 都是错误。Display schema 是 conversation-only。

`companionState.update` 请求为 `{ conversationId, changes: [{ path, value }] }`，成功返回空响应；revision 从 `companionState.get` 或 live state 的权威投影读取，不是 update 请求字段。Character/Display write 在同一领域边界提交；Runtime、Run、Artifact、permission 与 Pi 状态不属于该 state 投影。

## Artifact

Artifact 身份是不可变三元组：

```text
conversationId + runId + artifactId
```

read 使用有界 offset/length，返回 metadata、base64 chunk、next offset 和 EOF；客户端组合 Blob 只是一种显示实现。open/reveal/save-as 请求不接受 CAS 路径或用户目标路径，Host/外壳通过原生 presenter 完成动作并返回 outcome。

## 严格性与安全界限

- Host 定义的 object 使用 strict schema；未知字段不能无声穿透。Pi 原生 entry/message/event 使用原生类型与可序列化大小边界，不另造 strict transcript schema。
- ID、路径片段、数组、字符串、字节范围、MIME、URL 和枚举按各自导出 schema 限制；领域安全验证不能由 serializability 替代。
- filesystem path 不由 Renderer 声明为权威；本地 picker 结果在 main/Host 边界验证。
- secrets 不出 credential vault；diagnostics 字段在 schema 和 storage 两层脱敏。
- 请求/响应 schema 变化必须同步 registry、client、Host、UI 与相关测试；不得保留旧字段别名、静默兼容路径或另造 parallel contract。

## 验证

```sh
npm run typecheck --workspace @bear-harness/schema
npm run typecheck --workspace @bear-harness/protocol
npm run test:unit --workspace @bear-harness/protocol
```

新增接口必须测试请求边界、响应验证、跨领域 foreign ID、并发 Session event isolation 和非法路径/大小/MIME。
