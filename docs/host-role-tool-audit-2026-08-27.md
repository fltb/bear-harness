# Host → 角色模型工具审计（实施后）

日期：2026-08-27  
范围：极昼角色模型可见工具、Host 权限边界、通用状态、提交恢复、真实 Codex 委托与 TRACE。  
结论：旧的剧情变量/事件/选择插件不再构成极昼的第二套状态源；模型工具面被门禁固定为 `role_skill` 加 8 个条件式 Host 领域工具。角色状态由 JSON Schema 定义、Host 校验并按完整回答原子提交。

## 当前模型工具面

| 工具 | 行为 | 暴露条件 | 写入语义 |
| --- | --- | --- | --- |
| `role_skill` | 按逻辑 Skill ID 读取角色方法说明 | 角色包声明 Skill | 只读；不返回真实路径 |
| `host_state` | 读取或按 schema 操作通用角色状态 | 角色声明 state schema | 暂存到当前 Pi turn；助手成功后原子提交 |
| `host_visual` | 读取/选择角色包声明的场景和表情 | 角色声明视觉资源 | Host 校验声明范围并持久化 |
| `host_present` | 呈现角色包声明的选择或媒体 | 角色声明相应资源 | 写入可重建的呈现事件；普通选择发送普通用户消息 |
| `host_history` | 搜索同角色的其它对话 | 设置开启且当前用户话语明确授权 | 只读、限量、排除当前对话 |
| `host_canon` | 检索当前角色包原作资料 | 角色声明 Canon | 只读、按角色隔离 |
| `host_memory` | 记录当前用户消息形成的记忆 | 当前 turn 和角色能力允许 | 语义与实际持久化一致 |
| `host_attachment` | 列出/读取当前对话附件 | 当前对话存在附件能力 | 只读，不泄露源绝对路径 |
| `host_delegate` | 将不可变附件快照交给 Pi/Codex | 当前用户明确委托且执行器已同意 | 持久 run/evidence/输出附件；不写回原始来源 |

静态门禁 `scripts/check-role-tool-surface.mjs` 会从运行时注册点检查精确名称，旧名称或绕过注册会让 lint 失败。当前结果为：`role_skill plus 8 conditional Host domain tools`。

## 通用 JSON 状态

极昼包只声明通用 state buckets 和字段约束，不再声明 `continuity_stage` 一类重复剧情变量，也不加载 `jizhou-roleplay.mjs`：

- 操作：`set`、`increment`、`decrement`、`append_unique`、`remove`、`clear`。
- 约束：类型、枚举、数值上下界、数组成员、bucket scope、允许的 transition。
- 并发：每个 bucket 有 revision，可用 expected revision 拒绝陈旧写入。
- 提交：工具调用只创建与 Pi session、源用户 entry 绑定的 durable pending mutation；仅当同一 turn 写入成功助手 entry 后提交。
- 恢复：Host 重启会依据原生 Pi 会话核对 pending mutation；成功回答补提交，错误/中止/无权来源丢弃，重复恢复幂等。

角色选择现在是 package-declared presentation。用户点击后，Host 立即撤下选择并发送其 `message` 字段；模型再通过 `role_skill` 理解规则、通过 `host_state` 更新状态。这样选择本身不再偷偷修改一套平行状态机。

旧 `roleplay event` 解析只保留给导入旧角色包的兼容层，使用独立测试夹具验证；它不在极昼包、系统提示或模型工具面中。

## 权限与执行器

- 跨对话历史和工作委托都验证当前用户消息中的本轮授权，而不是只靠提示词。
- Skill 只向模型暴露逻辑 ID；真实安装目录由 Host 内部解析。
- 附件读取受 conversation ownership 约束，目录、文本、搜索均有限额。
- Codex 同意记录绑定原生二进制的 canonical path、版本、SHA-256，并同时绑定可选 `codex-code-mode-host` 的精确路径和 SHA-256。
- Codex 只读取用户 `~/.codex` 中登录所需文件生成每次运行快照；运行会话写入隔离快照，因此保留登录态而不让任务污染长期配置。
- 工作目录输入是只读快照，输出只进入 run 的独立 `outputs`，完成后登记为对话附件。
- 未匹配、版本不兼容和不可验证的 Codex 候选在 UI 中有不同状态，不把内部原生路径作为主要用户文案。

## TRACE 验证

诊断等级统一为 `TRACE / DEBUG / INFO / WARN / ERROR / FATAL`。TRACE 内容经过字段级脱敏、路径替换和 4096-byte 限长；发布包把环境请求的 TRACE 收紧为 DEBUG。

本次本地导出：`artifacts/manual-ui-audit-2026-08-27/traces/latest-completed-turn.json`。

- trace id：`f06d1208816da178e8351659d3cee9cc`
- 记录：34
- 损坏行：0
- 截断：false
- 包含：`companion.turn`、模型路由/请求、context compile、Skill read、5 次工具执行、Host 规则和 7 次角色状态 transition。
- 导出 JSON 中未发现 API key、authorization、token 或 secret 类字段。

## 验证结论

- 静态设计/数据/工具门禁：通过。
- 恢复专项：43/43。
- Host 覆盖率测试：495/495。
- UI 覆盖率测试：210/210。
- Desktop 覆盖率测试：147/147。
- WebDev 真实 Host 用户流程：24/24。
- Electron 源构建流程：3/3。
- 真实 Codex：登录复用、权限请求、运行完成、生成附件、Host 重启后会话与成果恢复均已人工验证。

本机已达到提交受保护 CI release gate 的条件。最终 1.0 发布仍必须由 CI 对 live-model、各目标平台安装包、签名/制品和 packaged-app smoke 给出独立 attestation；本地结果不能伪装成这些跨平台证明。
