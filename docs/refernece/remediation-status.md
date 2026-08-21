# 全量问题收束状态（已完成）

> 此文件记录 `orchestrate 收束并修复发现的所有问题` 的最终收束状态。F001–F075 全部已实现/已修复并进入当前工作树，最近一次全库门禁为绿色。本文取代此前的检查点版本：检查点中列出的未完成项已全部收敛（见「已收敛项」）。

## 最终验证结果

最近一次全库门禁在全部 remediation 改动进入工作树之后运行，结果全绿：

```sh
npm run lint          # pass
npm run typecheck     # pass
npm run test:unit     # pass
npm run build         # pass
npm run test:e2e:web  # pass — 21 passed, 1 skipped
```

- WebDev E2E：21 个用例通过；另有 1 个外部 live-model 用例在缺少外部模型配置时**有意跳过**（本仓库默认不携带真实模型服务配置，跳过是预期行为，不是失败）。
- 本门禁未运行 packaged Electron E2E（`test:e2e:electron` / `test:e2e:packaged`）；本文不宣称该路径已通过。

## 已收束范围（按阶段）

- Client/transport：F001–F009 — 已修复并验证。
- Internationalization：F010–F014 — 已修复并验证。
- WebDev：F015–F022 — 已修复并验证。
- Product/update：F023–F032 — 已修复并验证。
- Protocol：F033–F040 — 已修复并验证。
- Tdai core：F041–F049 — 已修复并验证。
- Desktop：F050–F056 — 已修复并验证。
- Companion UI：F057–F064 — 已修复并验证。
- Host runtime：F065–F073、F075 — 已修复并验证。

各项的原始类别、证据、next action 以及 resolved 状态与实现/测试证据，保留在 [issues-and-findings.md](./issues-and-findings.md) 的逐项记录中。

## 已收敛项

检查点版本列出的未完成项现已全部收敛：

1. **Canonical Host message ID 的直接记忆捕获**：`memory.capture` 已能解析当前 Pi branch entry，并对旧对话回退到该消息的 adopted Host version（foreign/missing 保持 `not_found`、非当前分支保持 `conflict`），WebDev memory journey 随全库 E2E 套件通过。
2. **Regenerate 后的 UI reload 验证**：chat journey 已确认 reload 后只保留一条 adopted `EDITED_OK`，随全库 E2E 套件通过。
3. **全库最终验证**：见上方「最终验证结果」，全部绿色。

## Findings register

[issues-and-findings.md](./issues-and-findings.md) 已把已修复的 F001–F075 逐项标记为 resolved：保留原始类别、证据与 next action，并补充 resolved 状态与实现/测试证据；汇总数字、队列与各模块 reference 的 known-findings 同步更新由该文件维护。验证期新发现的问题（如有）按其类别保留。

## 提交边界

当前 HEAD 仍为检查点提交 `04e2912d`（`wip(remediation): checkpoint outstanding E2E capture`）。检查点之后的全部 remediation 代码改动、本收束声明与最终验证结果均在当前工作树中，**尚未提交**。提交时应引用本文件与 issues-and-findings.md，作为 remediation 完成的记录。
