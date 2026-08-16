# Bear Harness Roadmap

> 永久维护的路线图，记录已确认的范围、完成记录和明确的后续阶段边界。
> 阶段边界变化必须先改本文件再实施。

## 当前交付范围（V1）

核心 Companion 与真实工作闭环，包含 M0–M5 六个里程碑及其完成后的可用性收口。详见 `docs/bear-harness-plan.md`。

### 2026-08-15 — V1 可用性收口

- WebDev 与桌面共用同一 HostRuntime、持久化数据库与角色包；WebDev 使用机器本地 AES-GCM 凭据 vault。
- 角色对话连续性、自动记忆、敏感记忆确认、故事档案与持久化的 AU 模糊变更确认均已接通。
- Canon Hub 已交付：原作资料分段、检索、可引用层级剧情模块和按话题激活的 Context Pack 路径。
- 普通用户使用角色管理、关系记忆与故事档案；高级制作使用角色包工坊，不向前者泄露 module、scope 或原始 prompt。
- 角色可提出现实工作草案；用户确认读写/联网范围后才执行，获准写入文件会登记为可下载成果。
- 会话支持新建、搜索、重命名、归档和删除；删除会保留已形成记忆但解除原会话引用。
- API key 与 OAuth 模型服务均有设置页路径；已保存 API key 会在重启后重新载入运行时。

### 完成记录

#### 2026-08-14 — M0 打包运行时 spike 与契约冻结

**交付内容**（映射 §14 验收点）：

| 验收点 | 状态 | 证据 |
|--------|------|------|
| node:sqlite 在 packaged app 中通过 | ✓ | 打包 mac universal 中 DatabaseSync WAL 写入/读取/integrity_check 通过（Electron 43.4.0 / Node 24.18.1） |
| sandbox preload + contextIsolation | ✓ | 现有 packaged e2e 断言 bridge shape `{platform, diagnostics}`，sandbox:true |
| bear-artifact 自定义协议注册+fetch 回环 | ✓ | `protocol.handle` + `net.fetch` 200 往返 |
| Companion utility 从 asar 加载 SDK 0.84.1 | ✓ | 隔离 agentDir 创建会话、analytics/installTelemetry 全零、无凭据 env 泄漏 |
| 真实 OAuth `auth_url` 桥接 | ✓ | pi-ai `ModelRuntime.login` 发出 Anthropic OAuth URL（PKCE + loopback） |
| 真实流式 turn + abort | ✓ | opencode-go/deepseek-v4-flash，80 message_update delta，89 事件，abort 正常终止，analytics 零 |
| Pi worker strict LF JSONL 分帧 | ✓ | `serializeJsonLine` + `attachJsonlLineReader` 经 CRLF/U+2028-29/跨 chunk/坏 JSON 测试；`rpc-entry` 端到端 `get_state` 响应 |
| Codex 版本不匹配显式禁 | ✓ | 发现 Homebrew `codex 0.146.0`，SHA-256 已算，pinned 0.147.0 不符 → `version_mismatch`，不替用户安装 |
| Office codec 边界 | ✓ | DOCX/PDF/XLSX/PPTX 生成→独立重开→hash/MIME/结构断言→保存回环全部通过；公式注入防护验证 |
| Windows 资产 hash 校验 | ✓ | pi-windows-x64.zip SHA-256 `20dd3a07...` ✓；PortableGit SHA-256 `016e8423...` ✓ |
| mac universal 打包 | ✓ | 278MB zip，含 SDK runtime 164MB（M2 可修剪 TUI/提供者/剪贴板） |

**M0 验收命令**（2026-08-14 门禁快照）：
```
npm run lint && npm run typecheck && npm run test:coverage && npm run build && npm run test:e2e:packaged
```

**提交**：`feat(p0): M0 完成 — 打包运行时 spike、契约冻结、11 项验收点全部通过`

### 本期不做、方向已定的后续阶段

#### 后续
- 角色包导出入口（导入、角色管理、作者工坊与 schema 已交付）
- MemoryCore 可选后端（§8.6）
- 云盘连接器
- 外部发送/分享
- Durable daemon（租约/重连/kill token，§9.5）
- 仅当 10,000 条真实消息 benchmark 失败才引入的 virtualization（条件项）

#### 后续扩展
- data-only SillyTavern importer（§12.3）
- 定时自动化
- 图片生成（Provider 能力成熟后）
- Hermes ACP/PTY（§9.4）
- Live2D 等表现 runtime（三平台+安全+许可证 gate 通过后，§12.3）

#### 实验性扩展
- 受限自动化层（capability-mapped）
- 高风险代码层（sandboxed iframe/utility origin）
#### 2026-08-14 — M1 Host 基础：schema、storage、artifact、事件与安全 IPC
- `packages/protocol/src/schema.ts`：统一 Zod 4 的 :v1 IPC 合约
- src/main/storage/database.ts + event-bus.ts + artifacts/index.ts
- IPC router + preload companion facade + global.d.ts + e2e bridge 断言
- 角色包架构决定：YAML 元数据、semantic tokens
- 提交：`91ab913`

#### 2026-08-14 — M2 Companion 垂直切片
- ProviderCatalog（pi-ai ModelRuntime 唯一引擎）、safeStorage CredentialStore
- CompanionSupervisor、ContextPackCompiler、TurnPipeline、VoiceStackManager
- FirstMeetingMachine（7 步 FSM，migration 3）、MemoryService（候选/审批/遗忘/召回）
- 真实 Provider 流式 turn + abort 已通过（opencode-go/deepseek-v4-flash，telemetry 零）
- 提交：`823bcce`

#### 2026-08-14 — M3 Commission、Executor 与 operational truth
- CommissionService（draft/approve/launch/needs_user/steer/interrupt/resume/cancel/adopt）
- PiRpcAdapter、CodexAdapter（pinned 0.147.0，version_mismatch 显式禁用）
- 提交：`6ca62b6`

#### 2026-08-14 — M4 材料、研究、Office 与文件效果
- IngestService、CodecRegistry（7 格式 parser+generator）、FileOpsService（plan/journal/undo）
- 提交：`a8ef748`

#### 2026-08-14 — M5 完整 UI、恢复与三平台 E2E
- Renderer 静态原型 → 真实 feature 组成（stores/ 桥接）
- Prototype 06 映射：TitleBar、Sidebar、PresenceStage、ConversationThread、Composer、FirstMeetingScene、Backstage
- Message ops：重新生成/切换版本/编辑/继续/这不像极昼/另开一段
- Host composition：全部 domain handler 接入 IPC router（30+ 通道）
- 门禁：lint/typecheck/125 tests/build 全绿
- 提交：`a8ef748aa9b5b9a4603d6a941448d46db089c4d2`

## 完成标准对照（§15）
- 同一位有稳定 Canon 和安全声明式表现的极昼 ✔
- 自然语言记忆请求经 permission/admission ✔
- 真实 Provider 回复可恢复（M0 已验证）✔
- Roleplay 操作不能改变现实事实 ✔
- Pi 与用户明确授权的 Codex 在批准范围内产生可追溯 evidence ✔
- 材料引用、安全解析、七类格式与文件效果是真实可重开的产物 ✔
- 失败不伪装成功 ✔
- Windows x64 离线资源完整性（M0 已验证 hash）✔；Windows 原生 runner E2E 尚待验证
