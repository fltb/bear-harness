# Host Runtime

## 职责

`@bear-harness/host-runtime` 是本地产品内核，入口位于 [`packages/host-runtime/src/runtime.ts`](../../packages/host-runtime/src/runtime.ts) 与 [`packages/host-runtime/src/composition.ts`](../../packages/host-runtime/src/composition.ts)。它负责资源管理和领域写入，不拥有 Pi 会话内容。

主要模块：

| 路径 | 职责 |
| --- | --- |
| `src/companion/pi-runtime.ts` | 多个真实 Pi `AgentSession` 的 Registry、open 去重和显式路由 |
| `src/companion/session-catalog.ts` | 当前角色的 Session 成员、归档和删除编排 |
| `src/companion/pi-live-events.ts` | 把 Pi 原生事件加上 session id 并投给临时通道 |
| `src/companion/companion-store.ts` | Character / Display 的统一角色级状态机制 |
| `src/companion/state-schema.ts` | `x-scope` 与 Character/Display 结构验证 |
| `src/storage/layout.ts` | `system/characters/companions` 路径与安全组件 |
| `src/storage/companion-storage.ts` | system DB 与每角色 DB 生命周期 |
| `src/storage/layout-migration.ts` | 旧平面布局的一次性原子迁移 |
| `src/models/registry.ts` / `src/providers/` | 系统模型池、角色默认 route 和凭据边界 |
| `src/memory/` | 显式 Memory 与角色级 TDAI runtime |
| `src/external-agents/run-service.ts` | Run 生命周期、恢复、证据与结果交付 |
| `src/artifacts/` | 角色 CAS、Artifact 完整性和有界读取 |
| `src/security/` / `src/diagnostics/` | 审计、适度策略、脱敏和角色级诊断 |

## 进程与角色生命周期

启动顺序：

1. 验证 `<dataRoot>` 并完成/恢复目录迁移；
2. 打开 `system/settings.db`；
3. 解析并验证活动角色包；
4. 打开 `companions/<id>/runtime.db` 和该角色的 EventBus、memory、Run、Artifact、audit/diagnostics；
5. 创建 Pi Registry 与类型化 Dispatcher；
6. 恢复可恢复的 Run，确认不可恢复的控制器丢失；
7. 对外开放 IPC/HTTP。

删除一个角色 runtime 前，Host 必须只关闭属于该角色的全部 Pi handles、memory runtime、Run controllers 和数据库句柄。Host shutdown 对所有已打开角色执行同样清理；`close()` 是幂等的终态清理。

## Pi Registry

Registry 内存只保留真实 handle、同一会话的 open promise、事件 unsubscribe/dispose 以及删除排他所需信息。它不保存 messages 或派生生命周期。

所有动作都显式传 `conversationId`：send、abort、navigate、edit、regenerate、continue、model route、rename、archive、delete 和 external result delivery。不同会话可以同时运行；改名不改变 UI active，归档不关闭无关会话，删除只处理一个目标。

原生 Pi 事件经过最小安全投影后进入 transient subscriber 集合。事件不落 durable EventBus；快照由对应 `AgentSession` 直接读取。

## Session Catalog

Catalog 位于当前角色 `runtime.db`，只保存 Pi session id、角色 membership 和 archived timestamp。标题读取与搜索连接 Pi 的原生标题，不保存副本。

删除验证 Catalog 所有权并锁定 route；如果目标正在运行则先 abort，随后 close 句柄、释放订阅、删除精确 transcript、清理会话级 Character/Display 和关联数据，最后删除 binding。任一步骤重复执行都不会误伤其他 session。

## Character / Display

`host_state` 接收 Pi 提供的 `conversationId` 作为产品数据 scope key；调用期间验证 schema、作用域、声明 ID 与 revision，并在一个角色数据库事务内提交 Character 和 Display。调用结束后不保留 Pi turn/message/tool id，也不等待后续事件。

Character 顶层 child 恰好一个 `x-scope: global | conversation`，后代不能覆盖。重建文档时使用浅层分区组合；Display 只读取当前 conversation 分区。

## 存储与迁移

系统与角色数据库由不同 handle 管理。系统配置和角色默认 route 需要协调时，使用明确顺序和补偿/重读，不虚构跨 SQLite 文件事务。

迁移使用 staging、所有权解析、数量/哈希/integrity 检查、fsync 和原子激活。无法归属的资源导致失败；成功激活后不保留运行时回退。备份按显式 retention 清理，产品删除不会默默留下无限期内容副本。

## Memory

`ExplicitMemory` 只响应用户明确的 remember/change/forget 意图，使用角色目录中的 `MEMORY.md`。TDAI runtime 使用系统 embedding 配置，但其 records/vector/index/checkpoint 全部在当前角色目录。切换 embedding 后每个角色独立重建。

打开真实 Pi `AgentSession` 时，Host 读取一次角色包稳定 Prompt、用户称呼和显式 `MEMORY.md`，组成该 Session 的稳定 system context。当前 Character/Display、按当前输入检索的 Canon 与 TDAI recall 通过 Pi `before_agent_start` 作为当轮临时 system context 注入，不写成 transcript message。Host 不做统一字符截断，也不实现第二套长对话摘要/压缩流水线；上下文窗口与 compaction 继续由 Pi 原生机制负责。

## Runs 与 Artifacts

Run 持有 executor 生命周期、权限、证据、workspace、输出与结果投递。终态结果按 `runId` 幂等投递给 `run.conversationId`，即使会话正在运行或不是任何窗口的 active。

启动扫描发现 executor 失联时，先 query/reattach；确认不可恢复才写 `forced_termination`。用户 interrupt 与此状态语义不同，前者在 controller 仍存在时可恢复。

输出捕获逐项验证 containment、symlink、MIME、大小和 SHA-256，然后将字节写入当前角色的 CAS。Artifact 查询和动作验证 conversation、run、artifact 三层归属。open/reveal/save-as 由外壳提供原生 presenter；普通 Host API 不接受 Renderer 目标路径。

## 事件与查询

durable EventBus 只承载角色产品域的 invalidation/audit notice。列表接口轻量且可分页；conversation、Run、Artifact 和 Character/Display 通过按 ID detail 读取。bootstrap 不扫描所有会话。

## 验证

```sh
npm run typecheck --workspace @bear-harness/host-runtime
npm run test:unit --workspace @bear-harness/host-runtime
npm run test:coverage --workspace @bear-harness/host-runtime
npm run test:release:recovery
```

核心测试应覆盖多 Session 并发与隔离、原生流、显式结果路由、改名/删除、目录隔离、迁移崩溃恢复、Artifact 归属/完整性、双层 onboarding 和 scope schema。
