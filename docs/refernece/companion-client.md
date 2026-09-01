# Companion Client

## 职责

`@bear-harness/companion-client` 位于 protocol 与 UI 之间。它根据共享 RPC registry 提供类型化调用，验证 request 和 response envelope，并把传输失败与 Host 返回的领域错误区分开。

公共实现位于 [`packages/companion-client/src/client.ts`](../../packages/companion-client/src/client.ts)。它不保存会话、查询缓存或业务状态。

## HostTransport

环境实现最小传输能力：

- `invoke(channel, request, signal?)`：一次 RPC；
- cache invalidation 订阅；
- transient live push 订阅。

Electron adapter 使用 preload IPC；WebDev adapter 使用 authenticated HTTP/NDJSON。两者共享同一份 schema 和错误语义，UI 不需要知道当前外壳。

## 调用链

```text
UI domain action
  -> CompanionClient validates request
  -> environment transport
  -> Host Dispatcher validates and calls handler
  -> response envelope
  -> CompanionClient validates response
  -> UI projects typed payload
```

transport rejection 代表请求没有得到可信 Host 响应，例如连接中断或 abort。Host error envelope 代表可信 Host 拒绝/失败，例如 not found、conflict、unauthorized 或 unavailable。调用者不得把两者都当成可安全重试的业务失败。

## Live stream

`live.stream(signal)` 暴露 `AsyncIterable<LivePush>`。Pi 事件保持原生形状，只在外层附带 `conversationId`；Character/Display、Run、embedding 下载和 provider 登录也沿这条即时通道推送。实现会验证每个 batch、限制内存队列，并在 abort/断线时清理 listener。

事件只用于即时 UI；流连接重新建立后，UI 对可见/打开的 conversation 请求权威 detail 并整体替换。

## 生命周期

创建 UI store 时注入一个 client；store dispose 时 abort 所有订阅。Electron window 或 WebDev page 销毁也必须使 main/server 侧订阅结束，避免 listener 和 response 泄漏。

## 添加接口

1. 在 protocol registry 定义有界 request/response；
2. 从共享类型导出而不是复制 interface；
3. 在 Host composition 注册 handler；
4. 通过 client facade 调用；
5. 为 Electron 和 WebDev transport 保持相同行为；
6. 增加 schema、dispatcher、client 和 UI integration 测试。

## 验证

```sh
npm run typecheck --workspace @bear-harness/companion-client
npm run build --workspace @bear-harness/companion-client
```
