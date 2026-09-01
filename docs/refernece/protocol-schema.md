# Protocol / Schema

## 责任

`@bear-harness/schema` 提供共享的 Zod 约束工具；`@bear-harness/protocol` 在 [`packages/protocol/src/schema.ts`](../../packages/protocol/src/schema.ts) 定义 RPC、响应包、领域类型、临时失效通知和 Pi 临时事件。这里是跨进程数据形状的唯一来源。

协议只保证形状、范围和枚举；领域所有权、路径 containment、凭据授权和内容哈希仍由 Host handler 验证。

## 通道类型

协议包含三种通道，不能混用：

| 类型 | 用途 | 持久性 |
| --- | --- | --- |
| RPC | 有界查询与命令 | 每次请求/响应 |
| Durable product event | 角色产品数据失效和审计 notice | 当前角色 `runtime.db` |
| Pi live event | token、tool、queue、error、settled 等实时投影 | 仅当前连接 |

Pi live envelope 必须带 `sessionId`，这样多个并发 Session 的更新不会串线。重连依赖 conversation detail/snapshot 覆盖本地投影，不依赖事件重播。

## RPC 领域

当前接口按所有权组织：

- bootstrap/system onboarding/settings/providers/models/embedding；
- character package、character onboarding、Character/Display；
- conversation Catalog list/create/open/get/rename/archive/delete/search；
- 明确 `conversationId` 的 Pi send/abort/edit/retry/navigate/continue/model；
- explicit memory、automatic memory settings、canon/story；
- external Run list/detail/control/evidence；
- Artifact list/read/open/reveal/save-as；
- diagnostics、audit 和更新。

conversation detail 与 Character/Display detail 按当前会话读取；bootstrap 不含所有会话的完整状态。列表返回轻量摘要，字节和证据由 detail/read 接口按需获取。

## 会话与流式类型

conversation open/get 响应由 Pi snapshot 投影而来，包含类型化 timeline 与 live fields，但 Host 不把它们写进自己的数据库。send、abort、edit、retry、navigate 等请求始终包含目标 conversation id。

Pi transient event 支持至少：

- `message_start` / `message_update` / `message_end`；
- tool execution start/update/end；
- queue update；
- agent/turn start/end/settled；
- entry appended、session info、compaction/retry 等 Pi 原生信号。

工具活动的 Renderer 投影不得携带秘密参数、完整 tool result 或本地内部路径。

## Character / Display

Character schema 的根不声明 scope；每个直接 child 必须声明且只能声明一次 `x-scope: global | conversation`；任意后代声明 scope 都是错误。Display schema 是 conversation-only。

Character/Display write 使用一个请求与一个响应，带目标 conversation 和 revision。Runtime、Run、Artifact、permission 与 Pi 状态不属于该响应。

## Artifact

Artifact 身份是不可变三元组：

```text
conversationId + runId + artifactId
```

read 使用有界 offset/length，返回 metadata、base64 chunk、next offset 和 EOF；客户端组合 Blob 只是一种显示实现。open/reveal/save-as 请求不接受 CAS 路径或用户目标路径，Host/外壳通过原生 presenter 完成动作并返回 outcome。

## 严格性与安全界限

- 所有 object 默认 strict；未知字段不能无声穿透。
- ID、路径片段、数组、字符串、字节范围、MIME、URL 和枚举都有上界。
- filesystem path 不由 Renderer 声明为权威；本地 picker 结果在 main/Host 边界验证。
- secrets 不出 credential vault；diagnostics 字段在 schema 和 storage 两层脱敏。
- 请求/响应 schema 变化必须同时更新 registry、client、Host、UI 与测试；breaking change 使用新 versioned channel。

## 验证

```sh
npm run typecheck --workspace @bear-harness/schema
npm run typecheck --workspace @bear-harness/protocol
npm run test:unit --workspace @bear-harness/protocol
```

新增接口必须测试请求边界、响应验证、跨领域 foreign ID、并发 Session event isolation 和非法路径/大小/MIME。
