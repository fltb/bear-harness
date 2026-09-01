# 系统架构

## 1. 设计结论

Bear 是 Pi Coding Agent 的本地桌面管理产品。Pi 与 Bear 的边界不是“谁写了更多代码”，而是谁对某类事实拥有最终解释权：

| 领域 | 权威 |
| --- | --- |
| 会话内容、消息、分支、模型历史、工具和生成生命周期 | Pi `AgentSession` |
| 会话属于哪个角色、归档状态、资源关闭与删除编排 | Bear Session Catalog / Pi Registry |
| Character 与 Display | 角色 `runtime.db` 中的统一事务机制 |
| 系统供应商、模型池、网络、embedding 配置 | `system/settings.db` |
| 显式与自动记忆数据 | 角色的 `memory/` 目录 |
| 外部执行工作、权限、证据与产物 | External Run |
| 生成文件身份、完整性和预览动作 | Run-owned Artifact 与角色 CAS |
| 当前窗口显示哪个会话 | Renderer 本地交互状态 |

Bear 可以管理 Pi 资源，但不能依据事件重建另一套消息、队列、流式或完成状态。

## 2. 分层

```text
┌─────────────────────────────────────────────────────────────┐
│ Electron Desktop / WebDev                                   │
│ 原生能力、进程生命周期、回环开发服务                          │
├─────────────────────────────────────────────────────────────┤
│ Companion UI                                                │
│ Renderer-local active + Pi/Character/Display reactive view  │
├─────────────────────────────────────────────────────────────┤
│ Companion Client + Protocol                                 │
│ validated RPC + durable invalidations + transient Pi stream │
├─────────────────────────────────────────────────────────────┤
│ Host Runtime                                                │
│ Pi Registry │ Session Catalog │ Character/Display │ Runs    │
│ Memory      │ Artifacts       │ Providers/Models  │ Security│
├─────────────────────────────────────────────────────────────┤
│ system/settings.db │ companions/*/runtime.db │ Pi sessions │
│ character packages │ memory/* │ run workspaces │ artifact CAS│
└─────────────────────────────────────────────────────────────┘
```

依赖方向是从外壳和 UI 指向契约，再由 Host 组合具体服务。Renderer 不导入 Node/Electron API；Host 不导入 UI。

## 3. 物理隔离

```text
<dataRoot>/
  system/
    settings.db
    security/
    providers/
    models/embeddings/
    updates/
  characters/<companionId>/
    character.yaml
    STORY.md
    assets/
    canon/
    plugins/
    skills/
  companions/<companionId>/
    runtime.db
    sessions/
    memory/MEMORY.md
    memory/tdai/
    runs/<runId>/
    artifacts/<sha256>
    audit/
    diagnostics/
```

三棵目录的含义不同：

- `system/` 是当前安装的共享配置，不保存角色内容。
- `characters/` 是可安装、替换、发布的角色包。
- `companions/` 是用户与某个角色共同形成的运行数据；一个角色一个文件夹，不跨目录复用数据库或 Artifact 字节。

所有 ID 在参与路径拼接前必须通过安全组件验证。Renderer 请求携带不可变 ID，不携带权威本地路径。SQLite 外键只约束单个数据库内部，不伪装跨库事务。

## 4. 会话资源模型

需要严格区分四个词：

| 词 | 含义 | 保存位置 |
| --- | --- | --- |
| `active` | 某个窗口正在显示的会话 | Renderer 内存 |
| `open` | Host 进程持有该会话的真实 `AgentSession` | Host Registry 内存 |
| `running` | Pi 正在处理该会话 | Pi 原生状态 |
| `streaming` | Pi 正在产生可流式展示的内容 | Pi 原生状态 |

一个 Host 可以同时持有多个真实会话；同一会话并发打开会被去重，不同会话可以同时使用不同模型。每条命令都带明确的 `conversationId`。界面切换只改变本窗口的 `active`，不会终止、关闭或改动其他会话。

Session Catalog 只保存角色成员关系和归档元数据。标题来自 Pi；搜索时即时连接 Catalog 成员与 Pi 标题，不能在 Catalog 复制标题、消息数、叶节点或运行状态。

## 5. 对话与原生流数据流

```text
Renderer 选择会话
  -> conversation open/get(conversationId)
  -> Host 打开或复用真实 AgentSession
  -> 返回该会话权威 snapshot
  -> Renderer 用 snapshot 整体替换这一会话的投影

Renderer 发送命令(conversationId)
  -> Host 显式路由到 Registry 中对应 AgentSession
  -> Pi 写自己的 transcript 并发出原生事件
  -> Host 给事件加 sessionId 后走临时流
  -> UI 响应式更新 token、工具、队列、error、settled
```

`message_update`、工具执行、队列、错误和 settled 信号只走 Pi 的临时直播通道。断线重连时重新读取权威 Session snapshot；临时事件既不回放为第二份 transcript，也不负责提交业务事务。

UI 可以从一个 Pi 源计算时间线分组、标签和展示状态。禁止持久化或维护竞争性的发送中、流式、队列或当前 turn 标志。

## 6. Character 与 Display

Character 是模型能理解的角色语义文档，Display 是当前会话的展示指令。两者是不同语义域，但共享角色数据库、事务提交和同一条响应式快照路径。

Character 根节点的每个直接子项必须声明一次 `x-scope`：

```yaml
relationship:
  x-scope: global
  # 当前用户与当前角色共享
scene_progress:
  x-scope: conversation
  # 仅当前会话
```

枚举只允许 `global | conversation`。后代继承作用域，不能再次声明；两类顶层 key 必须互斥。读取时对默认值、global 分区和当前 conversation 分区做浅层组合。Display 只有 conversation 分区。

模型只有 `host_state` 一个写入口。一次调用在一个事务内验证并提交 Character 与 Display；它不会等待后续 Pi 事件，也不能触发或回滚其他 Pi 调用。Run、Artifact、权限和运行状态不会进入这份快照。

## 7. 双层设置与 onboarding

系统第一次使用时完成 System Onboarding：

- provider 与凭据；
- 配置模型池及系统默认模型；
- 网络与下载源；
- embedding 配置和本地 embedding 模型获取。

新建角色只完成 Character Onboarding：

- 第一次见面；
- 关系起点和角色包声明的首次选择；
- 自动关系记忆许可；
- 从系统已配置模型池选择角色默认 route。

如果系统先决条件缺失，角色流程打开 System Settings 补齐，然后返回原位置；不会复制一份 provider、网络或 embedding 表单。角色 onboarding 的完成状态只写入该角色的 `runtime.db`。

## 8. 记忆数据流

显式 Memory 和自动 TDAI Memory 是两个域：

- 用户明确要求记住、修改或遗忘时，Host 才以有界、加锁、fsync、原子替换方式更新 `memory/MEMORY.md`。
- 自动关系记忆受该角色的 consent 控制，使用系统 embedding 配置，但把记录、向量、索引和 checkpoint 写入该角色 `memory/tdai/`。
- 冲突时显式 Memory 优先。

系统切换 embedding 模型或维度后，每个角色分别失效和重建索引。删除单个会话不删除角色记忆；删除角色 runtime 才关闭并移除其记忆资源。

## 9. External Run 与 Artifact 数据流

```text
Pi/用户请求工作
  -> 创建 Run(origin conversationId + trigger entry)
  -> executor 在 Run workspace 执行
  -> 权限、证据、进度由 Run 持有
  -> 捕获输出：路径/链接/MIME/大小/hash 校验
  -> 写入 companions/<id>/artifacts/<sha256>
  -> Artifact metadata 绑定 conversationId/runId/artifactId
  -> 结果以 runId 幂等地投递给原会话
```

目标会话正在运行也可以接收结果，Host 使用 Pi 原生 custom-message/follow-up 行为，不依赖 UI 是否显示它。用户中断且执行器仍存在时可以恢复；启动时发现失联只是检测条件，必须先 reattach/query，确认不可恢复后才记为 `forced_termination`。

Artifact 操作验证完整的 `conversation -> run -> artifact` 所有权链和内容哈希：

- preview/read 返回有界内容或字节范围；
- open/reveal 使用安全命名的 presentation copy 或不透明 capability；
- Save As 使用原生目标选择器，不持久化用户目标路径；
- 内部 CAS 路径不进入 Renderer。

## 10. 结果工作区

Run 开始、进行中和完成都不自动抢占会话。只有用户选择完成的 Run 或 Artifact 才打开结果工作区：

| 视口宽度 | 展示 |
| --- | --- |
| `>= 1600px` | 会话与结果相邻双列 |
| `768..1599px` | 右侧 overlay/drawer |
| `<= 767px` | 全屏结果视图 |

关闭结果，或切换到不拥有该结果的会话，恢复普通会话布局。

## 11. 快照与列表

- Pi native event 是临时运行信号，不写入数据库。
- bootstrap 只返回安装级/全局信息。
- conversation detail 通过显式、按 ID、有界接口读取。
- Catalog、Runs 和 Artifacts 使用轻量列表；需要完整内容时再读取 detail。
- 不允许为了初始化 UI 遍历每个会话并拼接全量 Character/Display 数据。

## 12. 删除

会话删除的顺序是：验证 Catalog 所有权、阻止新路由、必要时 abort、释放精确的 live handle 与订阅、移动/删除精确 transcript、清理该会话的角色数据并移除 Catalog binding。操作必须幂等且不得影响其他会话。

角色 runtime 删除先关闭其全部 Sessions、memory runtime、Runs 和数据库句柄，再把 `companions/<id>` 移到 Trash 或删除。角色包与角色 runtime 是两个独立选择。

## 13. 发布边界

发布结论只来自同一干净提交上的门禁证据：lint、typecheck、单测与覆盖率、Web required E2E、Electron E2E、恢复测试、build、security audit/signature、真实模型验证、各平台新包和 packaged smoke。公开分发还要求平台签名与 notarization。

具体命令和人工点击清单见[开发与发布验证](../development-verification.md)。
