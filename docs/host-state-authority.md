# Character / Display 与外部权威

## 核心原则

Host 是产品资源管理者和 Renderer 的统一入口，但不会把外部权威复制成 Host 私有事实。

| 事实 | 原始权威 | Host 的职责 |
| --- | --- | --- |
| Pi 会话内容与运行状态 | 当前 `AgentSession` 和 Pi transcript | 持有真实句柄、显式路由、投影 snapshot/event |
| Character / Display | 当前角色 `runtime.db` | 通过 `host_state.read/update` 读取或提交字段变化 |
| 系统设置 | `system/settings.db` / credential vault | 验证、保存非秘密配置、提供受限查询 |
| 自动记忆 | 当前角色 TDAI 数据 | 按角色创建/关闭 runtime，执行 consent |
| 外部工作 | Run aggregate / executor | 控制、证据、结果捕获和幂等投递 |
| 生成文件 | Artifact metadata + 当前角色 CAS | 所有权/完整性检查和安全展示 |

## 读取

读取路径固定为“权威源 -> Host 的有界领域查询 -> 类型化协议 -> UI 投影”。durable event 只让客户端知道哪些查询失效；Pi 临时事件只用于实时绘制。发生断线或序列缺口时，从权威 detail/snapshot 整体替换客户端投影。

## 写入

每个领域由一个明确的写入口负责验证、提交和返回。不得跨领域留下等待另一个事件才能确认的半事务：

- `host_state.update` 接收一个或多个 `{ path, value }`，在返回前完成 schema 校验和数据库提交；模型也可以分多次调用逐项修改；
- Pi 命令以明确 `conversationId` 直接调用对应会话；
- Run 状态只由 Run service 改变；
- Artifact 捕获先完整验证字节，再提交元数据；
- native Save As 是一次性 UI 动作，不进入产品数据库。

## UI 本地状态

UI 可以保存草稿、焦点、tab、当前窗口的 active conversation、选中的 Run/Artifact、drawer 是否打开等交互状态。这些值不能重新定义 Pi、Character、Run 或 Artifact 的业务状态。

## 禁止的复制

不要在 Host 或 UI 复制 Pi 的 messages、entries、leaf、工具执行、队列、idle/streaming/error 或当前 turn；不要在系统库复制角色运行数据；不要在一个角色目录复用另一个角色的记忆或 Artifact 字节；不要用一个通用 payload 桶代替明确的领域模型。

Character 字段的含义与更新方式直接写在角色包 JSON Schema 的标准 `title` / `description` 中。简单数字、布尔值和小型独立枚举可直接建模；复杂叙事进展使用自然语言摘要。

## 恢复

恢复意味着重新打开 owning source 并建立投影，不是根据历史通知猜测业务结果。Run 启动时的失联项先尝试查询/重连；只有确认执行器不再可恢复时才进入强制终止状态。数据库与文件事务的恢复规则由各自存储服务承担。
