# 线上最新版回归核查（2026-09-07）

> 后续状态：本文件保留的是合并前的上游缺陷基线。下列问题已在当前工作树完成语义合并与修复；内部 Pi Worker、Host Run tools 与结果工作区保持启用，仅外部 Codex 设置入口被遮罩。最终执行结果以 `main-conversation-behavior-acceptance-matrix.md` 第 9 节为准。当前主路径门禁通过，但公开发布仍因平台包、签名/notarization、packaged smoke 与外部设备项保持 NO-GO。

## 结论

核查对象为 `origin/main@181dd478d2bf33c2fe98ded6f6800f0433011d7c`，相对本地基线 `fbca0a2` 领先 6 个提交。

结论：**不能认定新版已消除此前问题，也不能进入正式发布。** 新版修复和增强了 Pi 原生投影、历史分页、工具执行、会话模型隔离与 `agent_end.messages` 传输裁剪，但仍保留或重新引入多项已知 UI/状态问题，同时其 required E2E、Host 单元测试和 live-model 门禁均未通过。

当前本地未提交 WIP 没有被覆盖；线上版本在独立 worktree 中核查。

## 已确认修复或改善

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| `agent_end.messages` 不进入 Host→Renderer | PASS | `projectPiTransientEvent()` 在 Host 边界丢弃整个 `agent_end`；Host 与 UI 均有直接单测 |
| 首段 assistant 流出现时的用户消息交接 | PASS | Codex 标签页实测：1 条权威用户消息、0 条 submission、“发送中”不残留，assistant 同一气泡流式增长 |
| 富 Markdown 基础渲染 | PASS | 标题、强调、列表、表格、代码、MathML 在确定性 Provider 的 streaming→settled 链路中可见 |
| 两会话并发和模型隔离 | PASS | required E2E 的双 Session 并发、切换、不同模型重启恢复均通过 |
| 原生工具投影与历史分页 | PASS | `native-projection.spec.ts` 2/2 通过 |
| 依赖漏洞与 registry 签名 | PASS | `npm audit`: 0 vulnerabilities；996 个包签名验证、311 个 attestation 验证 |

## 仍存在或新增的确定性问题

| 问题 | 结果 | 直接证据 |
| --- | --- | --- |
| Composer 草稿按会话隔离 | FAIL | 新版仍使用单一全局 `composerText`；新增后台 E2E 在切到 B 后实际读到 A 的草稿 |
| 禁止用正则猜 HTML/Markdown | FAIL | `MessageContent.filteredMarkup()` 使用两处正则检测标签和 Markdown 图片 |
| `MessageContent` 不重复保存/展示大载荷 | FAIL | 对过滤内容追加 `<details><pre>{props.text}</pre>`；8,000 字符样本被完整复制到第二棵 DOM |
| 单代码块复制 | FAIL | Codex 标签页富文本完成态含 1 个代码块、0 个代码复制按钮；扩展组件测试失败 |
| 普通链接安全策略 | FAIL | `http://` 和相对链接仍保留 href；HTTPS 链接没有 `_blank` 与 `noopener noreferrer` |
| 长回复复制全文与顶部/底部导航 | FAIL | 新版没有对应文案、控件或实现 |
| clean checkout 的 typecheck 自举 | FAIL | 干净 `npm ci` 后根级 typecheck 先缺 `@bear-harness/schema` dist，手工 build 后又缺 `@bear-harness/host-runtime` dist；手工按依赖顺序 build 后源码 typecheck 才通过 |
| ACP 取消与资源释放 | FAIL | Host 单元套件 494 通过、2 失败、1 跳过；失败为 `kill EPERM` 与 `acp_native_shutdown_timeout`，单独重跑稳定复现，并产生未正常退出的 worker |

## 新版自身门禁结果

| 门禁 | 结果 | 明细 |
| --- | --- | --- |
| clean install | PASS | 1006 packages installed；安装时审计 0 漏洞 |
| lint | PASS | Biome、knip、RPC/data/UI/release workflow 等守卫全部通过 |
| root typecheck（直接执行） | FAIL | workspace dist 构建顺序不自举 |
| root typecheck（手工补齐依赖 build 后） | PASS | 所有 workspace 通过 |
| 聚焦 UI 单元测试 | PASS | 64/64 |
| 全量 unit | FAIL | Host Runtime：494 pass / 2 fail / 1 skip |
| Web required E2E | FAIL | 43/46 pass；3 fail |
| live-model E2E（现有 Pi/Codex 配置，真实模型） | FAIL | 1/5 pass；4 fail |
| npm audit + signatures | PASS | 0 漏洞，签名与 attestations 通过 |

### Web required E2E 的 3 个失败

1. `conversation-usability`: 宽屏时 Composer 与对话列横向错位 19.203125px。该用例单独执行曾通过，整套执行失败，表明存在共享状态/时序污染或不稳定性。
2. `layout-dom` 1920×1080：点击 `e2e-report.txt` 后找不到 ready 的 Artifact preview。
3. `run-artifact`：生成工作簿的 Run 从 `enqueued` 进入 `failed`，未完成 A1:E5 下载验证。

### 真实模型 E2E 的 4 个失败

真实模型使用现有 Pi 配置的 `openai/gpt-5.6-terra`，第二模型为 `openai/gpt-5.6-sol`，后台 headless 运行。

1. smoke：内部等待允许 60 秒，但用例仍继承全局 30 秒 timeout，最终无 assistant 文本并超时。
2. native conversation journey：在模型旅程前调用 `settings.set({ firstRunStage: "role" })`，被新版 schema 以 `request_validation_failed` 拒绝。
3. natural story（scene/expression/media/choices）：同一过期请求在模型剧情开始前失败。
4. natural structured content：同一过期请求在模型输出 Markdown/公式/代码前失败。

只有“角色身份与显式记忆边界”一项真实模型测试通过。故新版虽然编写了自然剧情与富内容测试，其关键三项实际上没有到达模型阶段，不能作为 CG、场景、表情、Choices 或自然 Markdown 的实现证明。

## 可视证据

- `docs/evidence/latest-upstream-review/rich-content-no-code-copy.png`：富 Markdown 能渲染，但代码块没有复制入口。
- `docs/evidence/latest-upstream-review/composer-draft-leaks-after-switch.png`：创建并切换到新会话后，Composer 仍显示上一会话的未发送草稿。

## 发布判断

**NO-GO。** 至少需要先：移除 `MessageContent` 中的正则与原文副本、恢复按会话草稿、补齐代码复制/链接策略/长回复导航、修正 clean typecheck 顺序、修复 ACP 终止、让 46 项 required E2E 全绿，并修复 live-model setup 后真实跑通自然剧情和富内容。随后才应把线上 6 个提交与当前 WIP 做语义合并并重新执行完整矩阵。
