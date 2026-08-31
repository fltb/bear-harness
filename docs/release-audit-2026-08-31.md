# Bear Harness 1.0.0 Release 审计报告

审计日期：2026-08-31
审计对象：本轮 `main` Release Candidate 变更
结论：**工程候选版本通过；当前不允许公开 Release（NO-GO）**。

公开 Release 仍缺少同一干净提交上的正式 CI 证据：真实模型 attestation、全平台新鲜安装包与 packaged smoke、平台签名/notarization、最终 release attestation。证明脚本会按设计拒绝为 dirty tree 或证据不完整的提交签发最终证明。这些是发布流程缺口，不是本轮功能实现失败；本机现有 OAuth 的真实模型调用已经通过。

## 1. 本轮得到的产品形态

Bear 是一个管理型的 Pi 桌面产品，不是另一个对话引擎：

- Pi 是会话内容与运行状态的唯一权威：消息、分支、模型切换、流式 token、工具事件、队列、错误和结束状态都直接来自真实 `AgentSession`。
- Host 管理真实资源：角色包、每角色运行目录、Pi Session 句柄、Catalog 绑定、删除/归档/改名、Character/Display、Memory、External Run、Artifact 和安全边界。
- UI 只保留窗口本地的 active 选择，并响应式投影 Pi、Host 产品数据和 Run 数据；切到另一个会话不会停止仍在 running 的会话。
- 一个 Host 可以同时打开多个真实 Pi Session；不同会话可同时运行不同模型，Run 结果可投递给任意目标会话，包括正在 running 的会话。
- Onboarding 分为系统设置和角色设置。系统能力配置一次；新角色只走角色自身的首次见面、记忆同意和默认模型选择。
- Artifact 是 External Run 生成结果的正式产品对象，具备所有权、哈希、来源证据、安全预览、打开、Reveal、Save As 和损坏检测。

## 2. 物理隔离与本地文件树

角色包与角色运行数据分离；每个角色的运行文件和设置由一个独立物理目录承载：

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

边界含义：

- `system/settings.db` 只存安装级能力：Provider、凭据引用、模型池、Embedding 配置、网络和更新设置。
- `characters/<id>` 是可分发角色包，不混入用户运行数据。
- `companions/<id>/runtime.db` 是该角色的 Catalog、Character/Display、角色默认模型、角色 Onboarding、Run 与 Artifact 元数据。
- Embedding 配置和模型缓存属于系统设置；向量、索引、checkpoint、TDAI 数据和 `MEMORY.md` 按角色隔离。
- Artifact CAS 也是每角色独立，不跨角色硬链接或去重。
- 删除角色包与删除角色运行数据是两个独立动作；删除会话调用 Pi 标准删除，并清理 Bear 管理的关联数据。

实现入口：`packages/host-runtime/src/storage/layout.ts`、`companion-storage.ts`、`schema-sql.ts`、`packages/host-runtime/src/character-runtime.ts`。

本机实际迁移已执行：`/Users/bytedance/Library/Application Support/bear-harness` 现为 layout v2，`openai-codex` OAuth、7 个 configured models 和 `jizhou` 角色运行数据均已进入上述新位置。SQLite `integrity_check=ok`、外键错误为 0。原布局的原子备份位于 `/Users/bytedance/Library/Application Support/.bear-harness.runtime-layout-v1-backup-20260831113017`，按 7 天保留策略处理。真实启动时发现并修复了旧 Onboarding 的废弃 `conversation_history_read_enabled` 字段；修复只存在于一次性迁移转换，不引入运行时兼容分支。

## 3. 模块分层和实现路径

| 层 | 主要职责 | 核心路径 |
| --- | --- | --- |
| 产品配置 | 品牌、应用身份、发布版本单一来源 | `packages/product-config/src` |
| 协议 | RPC、事件、Snapshot、Run、Artifact、设置的 Zod 合同 | `packages/protocol/src` |
| Pi/Host 客户端 | 类型化 RPC 与 Pi 流式订阅 | `packages/companion-client/src` |
| Host 组合层 | 依赖装配、明确 `conversationId` 路由、RPC 注册 | `packages/host-runtime/src/composition.ts`, `runtime.ts` |
| Pi 会话层 | 多 Session Registry、真实快照、原生事件转发、标准删除 | `packages/host-runtime/src/companion/pi-runtime.ts`, `pi-live-events.ts`, `session-catalog.ts` |
| 角色产品状态 | Character/Display 同事务更新、`x-scope` 校验与响应式快照 | `packages/host-runtime/src/companion/companion-store.ts`, `state-schema.ts`, `host-tool-register.ts` |
| 角色包 | 角色 YAML、Canon、Story、Skill、插件信任、顶层 media/scenes/visual | `packages/host-runtime/src/companion/character-loader.ts`, `packages/host-runtime/src/canon` |
| Memory | 显式 `MEMORY.md` 与自动 TDAI 两套明确语义 | `packages/host-runtime/src/memory/explicit-memory.ts`, `tencentdb-runtime.ts`, `packages/tdai-core/src` |
| External Run | Executor 生命周期、权限、证据、恢复、结果投递 | `packages/host-runtime/src/external-agents/run-service.ts`, `src/executors` |
| Artifact | 捕获、哈希、CAS、所有权、预览和原生操作 | `packages/host-runtime/src/artifacts`, `apps/desktop/src/main/artifact-presenter.ts` |
| UI Store | UI-local active、查询同步、Pi 流式投影、显式 mutation | `packages/companion-ui/src/stores/companion.tsx`, `rpc-query.ts` |
| UI 产品层 | 对话、设置、工作区、角色与系统 Onboarding | `packages/companion-ui/src`、`src/features` |
| 桌面壳 | IPC、preload 安全桥、原生文件动作、诊断 | `apps/desktop/src` |
| WebDev | 与桌面共享 Host/UI 的浏览器验收壳 | `apps/web-dev` |

角色包旧权威已经清除：顶层 `roleplay` 包装、`choice_sets`、`roleplay.variables`、`roleplay.unlockables` 与 `host.event_reactions` 均已从协议、加载器、官方角色包、UI 投影和测试中删除，旧字段直接校验失败，不保留兼容读取。Character 的可变字段只由 `state_schema` 声明；Media 使用顶层声明和一次性 `host_media` 工具结果，Choices 由 `host_choices` 为当前回复动态生成。

## 4. 数据流

### 对话与流式显示

```text
用户点击发送
  -> UI 以明确 conversationId 调用 message.send
  -> Host Registry 获取该会话的真实 Pi AgentSession
  -> Pi 执行并产生 message/tool/queue/error/settled 原生事件
  -> session-tagged 临时流
  -> UI 查询缓存/时间线响应式投影
```

流式事件不写入 Host SQLite，也不经 durable EventBus 重建。断线后以 Pi 权威 Snapshot 替换 UI 投影。UI 没有 `sending` 第二状态。

### Character / Display

```text
Pi host_state tool(conversationId, patch)
  -> 校验 Character 顶层 x-scope = global | conversation
  -> 在单次 Host tool 调用内事务提交 Character + Display
  -> 发出失效通知
  -> UI 重取一个权威 Snapshot 并投影
```

不存在 turn journal、pending mutation、完成结算或跨工具回滚管理器。

### External Run 与 Artifact

```text
用户在会话 A 发起 Run
  -> Run 固定记录 conversationId=A
  -> 受限 Executor 工作目录执行
  -> 输出经过路径/symlink/MIME/大小/hash 校验
  -> 写入角色私有 Artifact CAS 和元数据
  -> 结果按 run.conversationId 投递回 Pi A
  -> UI 时间线显示完成；用户选择后才打开结果工作区
```

`active` 是当前窗口正在看的会话；`running` 是 Pi/Executor 的实际运行状态，两者没有互斥关系。启动时如果发现未结束记录但控制器不在内存，系统先 reattach/query；只有确认控制器已经丢失且无法恢复，才写 `forced_termination`。产品模型中不引入 `orphan` 状态或概念。

## 5. 用户问到的几个概念

- **Catalog**：每个角色下最小的 Session 成员表，只拥有 `Pi session id -> companion id + archivedAt`。标题、消息、数量、leaf、模型和运行状态仍从 Pi 读取。
- **Conversation select**：仅指某个 UI 窗口本地选择要显示哪个会话。Host 不保存全局 active。Rename 不需要也不会触发 select。
- **Snapshot 遍历**：旧方案会启动时 O(N) 扫描所有会话并拼出 Character/Display 全量快照；现已删除。Bootstrap 只取系统级信息，当前选中会话再显式查询详情。
- **Artifact UI**：展示 Run 产物的元数据、来源证据、完整性、受支持内容预览，以及打开、Reveal、Save As。它不是任意本地文件浏览器。
- **双列布局**：Run 开始时不触发，结果完成也不抢焦点；用户选中已完成 Run/Artifact 时才展示。`>=1600px` 双列，`768..1599px` 右侧 Drawer，`<=767px` 全屏结果页。

## 6. 代码量与工程规模

统计口径：模块生产 `*.ts` / `*.tsx` 物理行；测试文件数统计 `*.spec.ts[x]`，脚本测试另计。生成文件没有通过压行或元编程规避统计。

| 模块 | 生产文件 | 生产物理行 | 测试文件 |
| --- | ---: | ---: | ---: |
| product-config | 1 | 298 | 0 |
| i18n | 6 | 2,039 | 2 |
| schema | 1 | 9 | 0 |
| protocol | 2 | 2,793 | 1 |
| companion-client | 3 | 303 | 0 |
| host-runtime | 66 | 22,595 | 60 |
| companion-ui | 49 | 9,889 | 30 |
| tdai-core | 47 | 18,308 | 0 |
| desktop | 14 | 4,184 | 16 |
| web-dev | 7 | 1,044 | 10 |
| **合计** | **196** | **61,462** | **119 + 4 个脚本测试** |

原八个重复会话核心文件的锁定基线和当前值：

| 文件 | 基线 | 当前 |
| --- | ---: | ---: |
| `supervisor.ts` | 1,624 | 0（删除） |
| `turn-pipeline.ts` | 953 | 0（删除） |
| `pi-session-store.ts` | 411 | 0（删除） |
| `character-behavior.ts` | 859 | 0（删除） |
| `pending-turn-store.ts` | 510 | 0（删除） |
| `companion-store.ts` | 758 | 166 |
| `state-service.ts` | 793 | 0（删除） |
| UI `stores/companion.tsx` | 2,906 | 825 |
| **合计** | **8,814** | **991** |

净减少 7,823 行，即 **88.76%**。用户已授权从 `AGENTS.md` 和自动检查中移除 Host 核心行数硬门禁；因此行数只作为审计指标，不再单独决定 Release。实际结果仍显著低于旧门槛。

## 7. 已删除的重复权威

代码扫描与门禁确认以下模型不再存在：

- `CompanionSupervisor`、Host turn pipeline、Pi session transcript store；替代为真实 Pi `AgentSession` 和原生事件。
- `pending_turns`、`PendingTurnStore`、`host_pending_turn`、pending state mutation、turn journal、settlement 推断。
- Host 复制的 `runtimeState`、流式/错误/队列状态、tool execution 状态。
- UI `sending` 权威字段。
- Host 全局 `activeConversationId`；当前同名状态只存在 UI Store，且是窗口本地显示选择。
- Character Snapshot 中的外部 Run permissions。
- 独立可写 `collection` 域及旧 `relationship` / `character` 存储 scope。
- `x-scope` 现在只接受 `global | conversation`，子节点不能覆盖顶层分区。

## 8. 验证结果

### 静态和单元门禁

- `npm run lint`：通过，包含数据边界、角色工具面、Renderer push、UI effect/design language 和 Release workflow 检查。
- `npm run typecheck`：全部 workspace 通过。
- `npm run test:unit`：**771/771** 通过。
  - 脚本 13；i18n 9；protocol 7；host-runtime 432；companion-ui 167；desktop 139；web-dev 4。
- 恢复套件：**5 files / 42 tests** 通过，覆盖存储 crash recovery、durable transaction、角色导入、Companion State、Session Catalog。
- `npm run build`：desktop 与 web-dev 全部通过。

### 覆盖率

| 模块 | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| host-runtime | 77.82% | 65.60% | 78.52% | 80.95% |
| companion-ui | 85.83% | 73.10% | 86.86% | 88.24% |
| desktop | 83.89% | 73.22% | 93.69% | 87.37% |

三者均通过仓库配置阈值。风险较高但覆盖相对薄弱的区域是 Host executor router/adapter、TDAI Host adapter 和尚未配置真实服务的集成分支；它们不能由单元覆盖率数字替代真实模型/真实执行器验证。

### 真实 UI 验证

- WebDev required E2E：**23/23** 通过。
- Electron E2E：**2/2** 通过。
- 最新本地数据中的 `openai-codex` OAuth 已成功解密并以 `stored` 状态加载；真实模型 `GPT-5.6 Sol (OpenAI Codex)` 完成多轮角色剧情。
- 真实模型依次调用两次 `host_choices` 和一次 `host_media("continuity_light")`；Choices 出现在各自 Pi 工具结果的位置，点击语义是普通自然语言消息，Media/Choices 均未写入 Display。
- 额外使用应用内真实浏览器点击时间线 MediaCard 的“查看”，共享 Artifact 响应式预览列成功打开并显示“继任规程”图片与说明。
- 之前的应用内真实浏览器验收还覆盖：系统模型设置、Embedding/Memory 设置、角色设置、首次见面、新建会话、发消息、流式 token、切换 running 会话、Run 完成、Artifact 预览与证据。
- Run/Artifact 真实路径验证得到 44B `e2e-report.txt`，SHA-256 `f22f...56dfe`，来源和完整性均可展示。
- 响应式实测：390×844 全屏结果；1280×800 右侧 576px Drawer；1920×900 双列 440px 结果列。

### 安全和供应链

- 本轮较早的依赖审计结果：高危漏洞 **0**；npm 签名 **986** 个验证通过；attestation **307** 个验证通过。
- 最后一次联网刷新被执行环境拒绝，因为 `npm audit` 会把依赖树/版本元数据发送给公共 npm 注册表；没有绕过该限制。
- Artifact 捕获、路径边界、symlink、CAS hash、ownership 和原生打开操作均有直接测试。
- Release evidence 会绑定 commit、package lock、Artifact hashes、CycloneDX SBOM 和所有阶段证明，并拒绝 dirty tree。

## 9. Release 阻断项与残余风险

### P0：公开 Release 必须先解决

1. **真实模型缺正式 CI attestation**：本机现有 OAuth 的真实调用已经通过，但发布证明仍要求同一 clean commit 上的 `live-model` CI job 成功并生成 attestation；本地手工证据不能替代该提交绑定。
2. **没有同提交的新鲜全平台包和 packaged smoke**：当前只验证 source build；macOS x64/arm64、Windows x64、Linux x64 的包、SBOM、hash 和 smoke 必须由 CI 重新生成。
3. **公开包未签名**：当前 Electron 配置明确生成 unsigned framework builds，CI 还设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`。macOS notarization 和各平台 publisher/signing policy 未完成，故不能公开分发。

### P1：平台范围必须明确

- External Run confinement 只实现 macOS `sandbox-exec` 与 Linux bubblewrap；Windows 当前 fail closed。若 1.0 宣称 Windows 支持 External Run，这是 Release 阻断项；若 Windows 1.0 明确不提供该能力，需在产品能力表和 UI 中显式标注，而不是静默失败。
- ACP 通过匿名 stdio controller 启动时，Host 重启后通常没有可重新连接的远端标识。当前策略是先查询/重连，确认控制器丢失才 `forced_termination`，安全但不能承诺任意执行器跨 Host 崩溃续跑。

### P2：后续质量改进

- 补高 executor router、真实 ACP adapter、TDAI 外部服务适配分支的集成覆盖。
- 在干净 CI 中重新跑 npm vulnerability/signature audit，刷新本报告中较早取得的供应链数字。
- README 已纳入文档清理计划；已删除旧架构审计、旧 roadmap 和过时同步方案，剩余参考文档已经按新权威模型更新。

## 10. 最终判定

### 功能与架构

**PASS。** 用户本轮确认的多 Pi Session、active/running 区分、Pi 标准删除、每角色物理隔离、Embedding 系统设置、两层 Onboarding、原生流式显示、Character/Display 单一响应式源、External Run/Artifact 和响应式结果工作区均已实现并由测试覆盖。

### 内部工程候选版本

**CONDITIONAL GO。** 可以提交为 Release Candidate，并触发干净 CI。Host 行数不再是阻断项。

### 立即公开 Release

**NO-GO。** 必须先完成：

1. 在同一 commit 上跑完整 CI，包括已在本机验证通过的 live-model；
2. 生成四个平台新包、SBOM、hash 和 packaged smoke；
3. 决定 Windows External Run 的 1.0 支持范围；
4. 完成公开发行所需签名和 macOS notarization；
5. 由 `release-attestation.mjs final` 验证所有阶段和包均来自同一 clean commit。

只有上述五项全部完成，Release 结论才可从 NO-GO 翻为 GO。
