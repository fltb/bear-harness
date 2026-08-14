# Bear Harness Roadmap

> 永久维护的路线图，记录已确认的范围、完成记录和明确的后续阶段边界。
> 阶段边界变化必须先改本文件再实施。

## 本期范围（P0）

核心 Companion 与真实工作闭环，包含 M0–M5 六个里程碑。详见 `docs/bear-harness-plan.md` 和 `local://core-companion-functionality-plan.md`。

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

#### P1
- 自有角色包 schema/作者表单/校验/导出/导入入口（§12.3）
- MemoryCore 可选后端（§8.6）
- 云盘连接器
- 外部发送/分享
- Durable daemon（租约/重连/kill token，§9.5）
- 仅当 10,000 条真实消息 benchmark 失败才引入的 virtualization（条件项）

#### P2
- data-only SillyTavern importer（§12.3）
- 定时自动化
- 图片生成（Provider 能力成熟后）
- Hermes ACP/PTY（§9.4）
- Live2D 等表现 runtime（三平台+安全+许可证 gate 通过后，§12.3）

#### P2+ experimental
- 受限自动化层（capability-mapped）
- 高风险代码层（sandboxed iframe/utility origin）