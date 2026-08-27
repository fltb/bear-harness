# 同步数据迁移台账

目标：Host 是状态总管理和前端唯一入口，领域原始权威可以是 Pi 等外部系统，Solid Query 是 renderer 唯一同步缓存。RPC 命令回执不等同于可覆盖新状态的读取快照。禁止定时轮询；变更经现有双向 RPC 推送，断线后读取权威投影恢复。

外接系统、存储和客户端缓存的身份及接受/恢复边界见 [Host 状态总管理与外接权威接入](host-state-authority.md)。

## 全量范围

页面输入草稿、焦点、展开状态、文件选择及本地 Blob 生命周期不是同步数据。

| 数据域 | Host 所有的实现/输入 | 当前迁移状态 |
| --- | --- | --- |
| 对话列表 | Host conversation | Query + 提交版本门禁；对话删除/归档清理关联缓存 |
| 活动对话/会话/分支 | Host 会话服务（Pi 适配器） | Query 唯一投影；命令回执触发重读，活动查询不创建 Pi 会话 |
| 消息/工具结果/版本 | Pi 会话投影 | Query；按对话/Pi session 拒绝跨会话事件 |
| 流式生成状态 | Pi live state | Query；同步读取 Pi live projection；持久化恢复沿用 pending-turn/Pi session 协议 |
| 对话搜索 | 对话列表 Query | 当前 UI 纯派生过滤；RPC search 无独立 UI 消费者 |
| 附件列表/目录/归属 | Host attachment | 按 conversation/attachment 缓存；删除关联清理 |
| 附件读取/预览/URL | Host attachment | Query 保存语义内容/目录/URL；组件仅保留选择 ID、浏览器 Blob 生命周期 |
| 上传任务/进度/结果 | Host upload session | Host 恢复投影 + Query；跨进程交互恢复的验证限制见下文 |
| 角色目录/活动角色/导入 | Host character | 角色目录 Query；活动角色由 Host 投影，切换触发依赖缓存刷新 |
| 角色包/配置/资源 | Host package | 按角色 Query；本地仅未保存编辑草稿 |
| 插件信任 | Host trust | 按角色 Query；确认命令后重读 |
| 已保存草稿/资产/修订/验证/发布 | Host draft | 草稿/修订读入 Query；命令后重读；当前无独立编辑页面消费者 |
| 场景/表情 | Host scene | 已移除 store 副本，由 snapshot Query 提供；媒体/选项由 Host 事件历史恢复 |
| 角色变量/解锁/选项/媒体 | Host roleplay | 已移除 store 副本，由 snapshot Query 提供；媒体/选项由 Host 事件历史恢复 |
| Onboarding | Host onboarding | 统一版本门禁；读取与持久化初始化分离 |
| Provider/模型目录/凭据状态 | Pi/provider catalog | Pi/Host 目录 Query；登录完成、导入、退出经命令/通知更新，读取不写模型库 |
| OAuth 会话/提示/授权入口/结果 | Host OAuth session | 已移入 Query；自动回归通过，真实账号授权仍需交互验收 |
| 启用模型池 | Host model pool | Query + 提交版本门禁；自动回归通过 |
| 默认模型 | Host model defaults | Query + 提交版本门禁；自动回归通过 |
| 每对话模型路由 | Host model route | 按 conversation Query + 统一读取门禁 |
| 全局设置 | Host settings | Query + 提交版本门禁；自动回归通过 |
| 角色/关系设置 | Host settings | 按角色 Query；组件同步副本已移除 |
| 能力信息 | Host capabilities | Host 能力 Query；启动、设置变化及重连时读取 |
| Embedding 下载任务 | Host download | Query + Host 推送；进度/取消自动测试通过，真实大文件下载需交互验收 |
| 记忆记录 | Host memory | 按角色/范围/搜索词 Query；排除召回状态也由 Host 投影 |
| 记忆搜索 | Host memory | 按角色/范围/搜索词 Query；排除召回状态也由 Host 投影 |
| 记忆候选/审核 | Host candidates | 按角色/审核状态 Query；组件同步副本已移除 |
| Canon 来源/索引 | Host canon | 按角色 Query + RPC 显式 characterId |
| Canon 模块 | Host canon | 按角色 Query + RPC 显式 characterId |
| Canon 搜索 | Host canon | 按角色/搜索词 Query |
| 外部代理发现/连接/状态 | Host external agent | 当前无业务 UI 缓存；调试 RPC 查询进入共享 QueryClient |
| Runs | Host run | Host 当前角色 Run 投影 Query；角色切换及重连失效重读 |
| 权限请求 | Host pending permission | Host 恢复投影 + Query；跨进程交互恢复的验证限制见下文 |
| 更新状态 | Host updater | 当前无业务 UI 缓存；调试查询走 Query，检查/安装走 Mutation |
| 审计/导出/验证 | Host audit | 当前无业务 UI 缓存；调试查询走 Query，导出命令走 Mutation |
| Web-dev bootstrap/能力/调试目录 | Web-dev Host | 调试目录 Query，调用 Mutation，与应用共用 QueryClient；认证 token 留在传输层 |

## 一致性基础设施

- 数据库提交：业务表 SQL trigger 在同一 SQLite 事务追加同步日志；回滚同时回滚日志。
- 推送：提交完成后的微任务发送 `sync.invalidated`，不是定时轮询；已有事件通道负责断线恢复。
- 版本：Host incarnation epoch + 持久提交 revision；查询跨提交时重读，命令绝不自动重试。
- Query：统一比较已接受版本与失效水位，旧响应不得覆盖新投影；历史 epoch 推送不得切回旧 Host。
- 日志：只含表名/事件种类与版本，不含凭据或业务内容；保留有限尾部。

## 权威边界与验收限制

- SQLite 业务提交使用同事务 journal；事务是同步的，业务模块不得直接打开 SQLite 或跨 await 持有事务。
- Pi 会话、附件 CAS/上传 manifest、记忆后端各有自己的持久化所有者。Host 发布读取投影和提交通知，不把这些来源冒充成一个跨存储 ACID 事务。
- 记忆后端成功或不确定写入后统一发布 `memory.records_changed`，覆盖记忆新增、编辑、遗忘、失效、重要性和整理；通知进入 Host journal，其他缓存同步失效。选库与读写共用串行边界，后台 capture、L1/L2/L3 和索引完成同样通知；旧 Host/core 回调被拒绝。
- 命令回执不入读取缓存；草稿编辑、原生附件导入和上传完成均重读 Query。
- `setQueryData` 唯一入口是 `query-sync.ts`，门禁禁止绕过；删除后迟到读取被拒绝，角色切换不会沿用旧角色记忆 key。
- 断线恢复刷新全部缓存投影；恢复失败保留 stale 并重试连接，不以旧游标假装成功。连接重试不是业务数据轮询。
- 真实账号 OAuth、大模型文件下载，以及完整的上传/权限浏览器重启场景仍需交互验收；不得将模拟测试当作这些验收已完成。

## Effect 约束

- Renderer 禁用 `createEffect`、`createRenderEffect`、`createComputed`、`createReaction`；别名和命名空间引用同样检查。
- 唯一例外是 `lib/dom-effects.ts` 的文档标题和滚动 DOM 写入；不允许应用导入、状态 setter 或命令。
- 派生值使用 memo；读取声明 Query，写入由显式用户动作或 Host 通知处理。
- `scripts/check-renderer-effects.mjs` 接入 lint；门禁测试接入根 test:unit。

## 本轮验证记录（2026-08-27）

- UI 全量 177 项通过，包含删除缓存后迟到读取拒绝、附件预览和记忆排除投影。
- Protocol/Client、UI、Host、Web renderer/server、Desktop main/preload/renderer 类型检查通过；根 lint 与生产 build 通过。
- Host 全量 482 项通过、3 项跳过；Protocol 26 项、Desktop 147 项、i18n 9 项、Web 数据目录 4 项、Effect 门禁 2 项通过。
- 浏览器全量 22 项通过、真实模型 1 项按配置跳过，覆盖 onboarding、聊天刷新、附件委派/刷新/下载、角色连续性、记忆和设置；聊天断言没有 sequence gap 和未处理 pageerror。
- 上述自动测试不等同于真实账号 OAuth 授权、大文件下载或跨存储崩溃一致性的完整验收。
