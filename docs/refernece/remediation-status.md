# 全量问题收束状态（未完成检查点）

> 此文件记录 `orchestrate 收束并修复发现的所有问题` 执行中的明确检查点。它不是“已完成”声明；后续工作必须从本文件列出的未完成项恢复。

## 已完成并已局部或全库验证的阶段

- Client/transport：F001–F009。
- Internationalization：F010–F014。
- WebDev：F015–F022。
- Product/update：F023–F032。
- Protocol：F033–F040。
- Tdai core：F041–F049。
- Desktop：F050–F056。
- Companion UI：F057–F064。
- Host runtime：F065–F073、F075 的实现改动已进入工作树；其中多项已由包级测试覆盖。

最近一次成功的全库门禁发生在后续 Host/Pi 投影与 E2E 修复之前。当前检查点**不能**视为全库绿色。

## 当前未完成 / 未收敛项

### 1. Canonical Host message ID 的直接记忆捕获

当前 UI 对助手消息的“记住这一刻”发送 canonical Host message ID。Pi session 已存在时，`rememberConversationEntry` 优先按 Pi entry ID 查找，未把 canonical Host ID 映射回当前分支 Pi entry，因此 WebDev memory journey 中捕获结果没有写入 `memory.list`。

待完成：

- 在 `packages/host-runtime/src/composition.ts` 中建立 canonical Host message ID → 当前 Pi branch entry 的确定性映射；
- 保持 foreign/missing 为 `not_found`、非当前分支为 `conflict`；
- 修复并重新运行 `apps/web-dev/e2e/memory-journey.spec.ts`。

### 2. Regenerate 后的 UI reload 验证

Host unit regression已覆盖 regenerated assistant version 的 adopted 持久化；WebDev `chat-journey` 刚修复 rule provider 对 regeneration prompt 的响应条件，尚需在完整 E2E 中再次确认 reload 后只有一条 adopted `EDITED_OK`。

### 3. 全库最终验证

待运行且必须全绿：

```sh
npm run format
npm run lint
npm run typecheck
npm run test:unit
npm run build
npm run test:e2e:web
```

### 4. Findings register 状态更新

`docs/refernece/issues-and-findings.md` 仍以初始 75 项开放/已解决分类为主。等最终验证绿色后：

- 将已修复 F001–F075 逐项移入 resolved；
- 保留任何验证中发现的新问题；
- 更新汇总数字、队列和模块 reference 的 known-findings。

## 当前提交边界

本检查点提交的是已实施但尚未最终全库收敛的 remediation 工作。任何后续提交必须引用本文件，并在最终门禁绿色前不得把这批工作宣称为完成。
