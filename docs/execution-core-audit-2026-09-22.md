# 执行核心精简审计 · 2026-09-22

基线审计结论：**尚未达到最小精简，不满足当前 AGENTS.md 的架构验收条件。** Pi 原生执行主链已经建立，主要问题是旧的 Host 会话选择权威未清除、资源所有者不一致，以及 UI 对原生快照增加了相互干扰的控制逻辑。应先修复生命周期边界，再删除错误权威；不建议重写 Pi 包装器或笼统削减状态机。

本文保留改造前的发现与证据；后续完整方案已实施，整改状态与验证见 [实施报告](core-registry-implementation-2026-09-22.md)。下述旧行号均属于审计基线，不能用作当前代码定位。

审计分支：`codex/execution-core-audit`。基线：`bf3cbfb0d94f39acb54e250695a29a47e176c4c3`，开始时工作区干净。本次只增加报告和证据，未修改产品代码、角色内容或既有测试。以下位置均指基线源码。

后续范围澄清：用户明确要求保留 Codex 执行链供后续修复，F7 的删除建议不进入本轮整改。Artifact 功能及其数据模型也不能仅凭“没有生产调用/读取”就删除；下面已将原 P3 删除建议更正为接口与功能接通情况的待核实项。产品代码整改当前暂停，尚未开始。

## 范围与规模

按职责划分 7 组执行相关代码，共 **53 个生产文件、21,609 行**。计数含注释和空行，不含测试、生成文件及第三方源码；这是结构盘点口径，不代表逐行形式化证明。另盘点整个 Host：73 个生产文件、26,693 行。

| 模块组 | 文件数 | 行数 | 职责 |
| --- | ---: | ---: | --- |
| Pi 会话、Catalog、上下文、工具 | 7 | 2,314 | 原生会话管理与角色工具接入 |
| Host 装配、路由、角色生命周期 | 6 | 2,888 | 服务装配、RPC、资源存续 |
| External Runs、执行器、Artifacts | 11 | 5,159 | 独立工作、权限、产物、结果交付 |
| 存储与安全 | 12 | 3,753 | 物理隔离、数据库、审计、文件事务 |
| 协议与客户端 | 5 | 3,288 | 契约与调用边界 |
| UI 执行投影 | 9 | 3,261 | 选中会话、原生事件、快照、结果 |
| Web / Electron 运输层 | 3 | 946 | HTTP、IPC、订阅 |

审计方法：并行审阅调用链和数据所有权、全仓引用检索、检查已安装 Pi 原生实现、全仓 lint/typecheck、现有单元测试，以及隔离临时数据上的生命周期和 UI 竞争复现。另交叉检查 onboarding / memory 门控。文件清单、源码 SHA256、测试结果和复现原始输出见 [机器可读证据](evidence/execution-core-audit-2026-09-22.json)。

## 正确的所有权边界应继续保留

- **Pi**：真实 `AgentSession`、消息和分支、模型历史、执行与队列、工具生命周期、流式事件。Bear 读取快照并调用原生操作。
- **Bear Host**：Catalog membership / archive、真实句柄、打开去重、删除排斥、按会话 admission、角色数据库、Memory、Run 和 Artifact。
- **Renderer**：窗口自己的 active conversation、媒体和结果选择，以及可被 Pi 快照替换的瞬时投影。
- **External Run**：执行器自身生命周期和权限、证据、临时工作区、产物及 `runId` 交付幂等；它不是 Pi 对话的第二套运行状态。

没有发现需要整体推翻 `pi-live-events`、临时上下文注入、`host_media/host_choices` 原生工具结果语义或 CAS capability 的证据。`sessions/opening/deleting`、Run admission 去重、真实执行器句柄、取消与暂停区分、文件完整性检查均有必要。不能仅根据 Map、Promise、queue 或 `settled` 的命名判断应删除。

## 发现与建议

P1 表示数据/资源生命周期缺陷或明确硬约束违背；P2 表示正确性、可扩展性或明确冗余；P3 表示后续收敛机会。未将静态推断冒充真实端到端复现。

### F1 · P1：Host 仍是持久化的会话选择权威

位置：[session-catalog.ts](../packages/host-runtime/src/companion/session-catalog.ts) 38、62–98、221–301；[schema.ts](../packages/host-runtime/src/storage/schema.ts) 89–97；[composition.ts](../packages/host-runtime/src/composition.ts) 507–548；[companion.tsx](../packages/companion-ui/src/stores/companion.tsx) 429–430、1479。

真实存在 `active_conversations` 表、`selectionTail`、`createAndSelect`、`activeGet/select`、失败时恢复旧选择；archive/delete 还返回 Host active。UI 初始化和重连继续读取它。两个窗口选择不同会话时共享一条持久化选择，后续响应可能把另一窗口的选择带回来。它直接违反“active 为窗口本地、不得实现 Host activeGet”的约束。

**建议**：成套移除表、RPC、选择串行队列、选择回滚及对应旧测试；create 只注册 membership，open 只打开显式 ID，archive/delete 只返回操作结果，窗口自行管理选择。仅 Catalog 就有约百行可收敛逻辑；确切净减少量需实现后统计。现有 `conversation-local-active.spec.ts` 的 suite 实际名为 `Host-authoritative conversation selection`，测试通过不能证明符合新边界。

证据：真实数据库和调用链；多窗口影响为由共享权威推出的场景，未运行双窗口 E2E。

### F2 · P1：角色多代资源与数据库的所有者不一致

位置：[host-event-loop.ts](../packages/host-runtime/src/host-event-loop.ts) 100–123、172–191；[runtime.ts](../packages/host-runtime/src/runtime.ts) 258–263、476–484、493–498；[companion-storage.ts](../packages/host-runtime/src/storage/companion-storage.ts) 38–43、61–66、74–77。

Host lifecycle 按 `characterId:generation` 管资源，Storage 却只按 `characterId` 复用和关闭数据库。A 有未完成请求时切 B 再切 A，会创建 A 的新代实例并复用旧数据库；旧请求完成后，旧实例按角色 ID 关闭数据库，新 active A 随即失效。

真实 Host / SQLite 隔离复现输出：`oldRuntime=jizhou:1`、`newRuntime=jizhou:3`、`sharedDatabase=true`，旧实例结束后新实例查询报 `database is not open`。

同一边界还有第二个已复现问题：A 处于 `retiring`、`pendingRequests=1` 时，切到 B 后删除 A，接口返回 `deleted=true`，但 A 仍在 lifecycle registry 中，目录已经消失。删除只挡当前 active，未先关闭仍存活的 Pi / Run / memory 资源。

**建议**：统一角色资源注册表与数据库的生命周期身份；每角色保留唯一资源所有者，或在前代退出前禁止创建新所有者。释放必须匹配 exact handle；删除须先排斥新路由并等待该角色所有资源退出，再动目录。上下文应绑定不可变 characterId，避免在 pinned resource 中重新读取全局 active character。先解决所有权，再考虑缩减 generation/phase 的重复表述。

证据：两个真实 Host / SQLite 临时数据复现；用显式延迟的已接纳请求制造交错，不涉及真实用户数据或模型调用。

### F3 · P1：首轮关闭后误删已经落盘的会话 Catalog

位置：[pi-runtime.ts](../packages/host-runtime/src/companion/pi-runtime.ts) 474、494–500；[character-runtime.ts](../packages/host-runtime/src/character-runtime.ts) 228–229。

`closeNow` 在 abort 前缓存文件是否尚未生成；Pi abort 会把首轮 user 和 aborted assistant 落盘，但 Bear 仍按旧布尔值调用 `sessionDiscarded`，删除 Catalog。重启后这段会话不再出现在列表，文件则成为孤儿。

真实 Pi `AgentSession` 配离线 provider stub 已复现：关闭前 `isStreaming=true, transcriptExists=false`；关闭后 `transcriptExists=true, catalogDiscardCallbackFired=true`，文件包含 user 和 aborted assistant。

**建议**：先停止并等待 Pi 原生持久化完成，再依据最终文件状态决定是否丢弃未形成的空会话。无需增加生命周期镜像。

### F4 · P2：后台标题任务能在删除后重建损坏的 transcript

位置：[pi-runtime.ts](../packages/host-runtime/src/companion/pi-runtime.ts) 172–173、918–939。

首轮自动标题请求未跟随会话句柄生命周期。会话删除后，迟到的模型结果仍执行 `session.setSessionName()`。使用真实 `SessionManager` 和 PiRuntime 删除路径复现：删除后文件不存在；标题返回后原路径重新出现，只有 `session_info` 一行，没有 session header。

**建议**：标题提交进入现有按会话排斥路径，并确认 exact handle 仍在 Registry 且未被删除；关闭时取消标题请求或丢弃迟到结果。保留标题在 Pi 中的权威位置。

### F5 · P2：无关会话导航会丢弃背景会话的完成快照

位置：[companion.tsx](../packages/companion-ui/src/stores/companion.tsx) 955–963、1098–1118、1321–1328。

所有 Session 快照都绑定全局 `activeMutationGeneration`。背景 B 收到 `agent_settled` 并读取权威快照时，用户从 A 切到 C，会让 B 的读取作废；没有后续事件时也不会重试。UI 又正确地不单凭 settled 推断 idle，导致 B 一直显示 streaming，完成标记丢失。

通过真实 store + 现有 fixture 的临时测试复现：B 的 idle 快照已返回，UI 仍为 `isStreaming=true`，且只调用过一次 open。

**建议**：Session 快照只受自己的读取代数及角色 epoch 约束；导航代数仅约束当前选择提交。删掉全局导航对无关会话读取的控制。

### F6 · P2：重连快照失败被吞掉，却显示已连接

位置：[companion.tsx](../packages/companion-ui/src/stores/companion.tsx) 243–259、1478–1488、1681–1682。

`settlePiSnapshot` 将读取失败与取消统一变成 undefined；上层正常返回，随即置 connected。若断线期间 Pi 已完成，而第一次重连快照临时失败，之后又没有新事件，旧历史和 streaming 可一直保留。

临时 store 测试复现：订阅已重建、activeGet 只尝试一次，UI connected 但仍显示断线前 streaming。

**建议**：快照读取失败传播到已有重连退避；只有取消或过期读取静默结束。权威快照替换成功后再认定恢复完成。

### F7 · P2：Codex 执行链与声明接口存在接通缺口（按用户要求保留）

位置：[character-runtime.ts](../packages/host-runtime/src/character-runtime.ts) 267–270；[run-service.ts](../packages/host-runtime/src/external-agents/run-service.ts) 192、215；[codex-adapter.ts](../packages/host-runtime/src/executors/codex-adapter.ts) 全文件 552 行；[protocol/schema.ts](../packages/protocol/src/schema.ts) 2360、2418–2436。

新 Run 固定走 `pi-default`，生产只注册 Pi。全仓没有生产 `new CodexAdapter` 或 codex controller 注册，但仍保留完整 adapter、协议、UI/store、依赖及测试。

实际实例化 Host 并对照声明：**118 个 RPC 契约、114 个 handler**。缺少 `provider.loginSessions`、`externalAgent.discoverCodex`、`externalAgent.connectCodex`、`externalAgent.status`。前者仅声明无调用，后三项属于残余执行器链。`check-rpc-contracts.mjs` 并未检查声明与 handler 全量对应，尽管 composition 文件头声称门禁能保证这一点。

**范围修正**：用户明确要求保留 Codex 执行链待后续修复，因此保留 adapter、相关契约、UI、依赖、测试和 ExecutorRouter，不将其计入精简收益。该项作为接通缺口记录；不能仅凭当前 Pi-only admission 判断其产品能力应该删除。

### F8 · P2：整个 Run 的进度正文被累计为最终结果

位置：[acp-executor.ts](../packages/host-runtime/src/executors/acp-executor.ts) 242、284；[run-service.ts](../packages/host-runtime/src/external-agents/run-service.ts) 343、1353。

所有 assistant chunks 累计进 `messageText`，completed 用它作 summary，再截开头 12,000 字符，交付会话时再截开头 4,000 字节。长任务前期解释、工具前说明、interrupt/resume 前的内容会挤掉后面的真正结论。

**建议**：从原生 Pi 终态取得最终 assistant 结果，显式传递结果字段；进度证据继续独立处理，删掉 Run 全程正文累计副本。本项为确定性代码路径分析，未额外调用长任务模型复现。

### F9 · P2：分页发生在全历史扫描之后

位置：[session-catalog.ts](../packages/host-runtime/src/companion/session-catalog.ts) 40–59；[pi-runtime.ts](../packages/host-runtime/src/companion/pi-runtime.ts) 118–138、535–541；[composition.ts](../packages/host-runtime/src/composition.ts) 493–505。

读取全部 Catalog membership，再调用 `SessionManager.list`，最后才 slice 返回页。单 Session 的冷 open/rename 等定位也调用全量 list。核对本地 Pi 实现发现 list 会逐行读取 transcript 并拼装 `allMessagesText`；返回 20 项不等于只做 20 项的工作。

**建议**：优先推动或使用经确认存在的 Pi 轻量列表/定位能力，或在 Bear membership 侧保留经过校验的 transcript 资源定位；本次未确认当前 SDK 已有可直接替换的轻量 API。不可复制 title、messages、counts 成第二权威。本次未做大历史基准测试，结论限定为实际调用复杂度和 I/O 路径。

### F10 · P1：自动记忆缺少角色自己的 consent 门控

位置：[character-runtime.ts](../packages/host-runtime/src/character-runtime.ts) 160–173、421–422；[first-meeting.ts](../packages/host-runtime/src/companion/first-meeting.ts) 174–209；[onboarding-schema.ts](../packages/host-runtime/src/companion/onboarding-schema.ts)。

实际 `memoryEnabled()` 只读取系统 `memoryVectorService.enabled`；recall/capture 以此门控。角色 onboarding 的 effect 只处理 nickname，没有角色记忆许可接入。因此系统能力开启后，新角色的自动记忆无需自己的 consent 就可进入。这违反“系统配置能力、角色决定记忆许可”的边界。物理记忆目录隔离是正确的，但不能代替许可隔离。

**建议**：把单一角色 consent 保存在该角色 runtime.db，生效条件为系统能力可用且该角色许可。缺失时默认未授权；不重复 embedding/provider 配置。本项基于门控实现与 schema 审阅，未运行真实模型记忆写入。

## 进一步收敛与残余风险

1. **P3（更正）：Artifact 接口与功能接通情况需分别判断。** `artifacts/index.ts` 的 `createFromPath`（182–191）、`markAdopted`（315–323）、`readBlobByHash`（423–445）没有全仓生产调用，但这不足以证明其对应产品能力应删除。实际产物捕获调用 `createFromPathSync`；预览调用带三层归属校验的 `readBlobRange`；open/reveal/saveAs 及 markSaved 有真实调用。因此前两条读取/捕获路径上的备用接口可评估等价收敛，而 `markAdopted/artifactAdoptions` 应视为尚未接通的采纳能力，先明确用途。`runManifests` 由 Pi/Codex adapter 真实写入，只写未读可能是溯源展示缺口，不能直接归为多余持久模型；本轮保留。原先“删除 adoption/manifest”的建议证据不足，撤回，不再将其计入确定可删收益。Artifact 存储、元数据、预览、打开、定位、另存为、归属/完整性和溯源能力均保留。
2. **ACP 异常重启后可能永久占位。** `acp-executor.ts:92` 对不存在的本进程句柄返回 unknown；`run-service.ts:200` 仍把未完成 Run 计入最多两个资源占位，`:1179` 删除也会拒绝。保守 unknown 本身符合约束；缺的是可核验进程身份、退出证据或恢复途径。不能直接把 unknown 改成 forced_termination。
3. **Artifact capture 缺少实际工作量上限。** `run-service.ts:1548` 遍历深度无上限、文件数无上限、总大小仅做安全整数检查，`:1586` 未传已有 maxBytes。现有测试还明确接受 3×400 MiB。路径包含关系、拒绝 symlink/特殊文件、MIME、size/hash/fsync 仍保留。建议制定文件数、单文件、总量和遍历工作量上限；不要用新增执行状态机代替边界校验。
4. **大文件应按职责收敛，不能以拆文件冒充删复杂度。** `companion.tsx` 2,388 行、`run-service.ts` 1,688 行、`composition.ts` 1,364 行、`pi-runtime.ts` 980 行。先删 F1 的错误选择权威，再把每 Session 投影和 domain handler 分开；F7 的 Codex 能力按用户要求保留。HostEventLoop 的 phase/pendingRequests 管的是资源，不是 Pi 运行状态；其重复关闭分支可合并，但核心优先级是 F2 的身份一致性。

## 验证结果及局限

全程使用 `.nvmrc` 指定工具链：Node 24.19.0、npm 11.17.0。

| 检查 | 结果 |
| --- | --- |
| 全仓 lint（含 knip 和现有架构脚本） | 通过；knip 有 4 条配置提示 |
| 全仓 typecheck（含前置包构建） | 通过 |
| 根脚本单测 | 24 通过 |
| i18n / protocol / tdai-core | 12 / 16 / 8 通过 |
| Host | 合并首轮与环境复测：600 通过、2 跳过 |
| UI | 256 通过、1 跳过 |
| Desktop | 207 通过 |
| WebDev | 13 通过 |
| 生命周期隔离复现 | F2 两种交错、F3、F4 均证实缺陷 |
| 新的临时 UI 回归探针 | 2 项按正确预期断言均失败，证实 F5/F6 |

现有单测按唯一用例合计 **1,136 通过、3 跳过**。不是一次完整绿色 `test:unit` 调用：首轮在 Host 因沙盒禁止 localhost / macOS 子进程 confinement 出现 21 个失败；获得执行权限后重跑对应文件，失败消失，再继续 UI/Desktop/WebDev。重复定向通过项没有再次计数。新增审计探针的失败未计入既有测试通过数。

没有运行 coverage、真实浏览器 Web E2E、Electron E2E、完整 recovery release suite、应用生产 build、依赖签名/安全审计、live-model、平台打包或 packaged smoke。前置包编译通过不能替代完整应用 build。复现使用基线构建及隔离临时目录；真实 AgentSession 关闭测试使用离线 provider stub，不能称为 live-model 验证。

## 建议实施顺序与发布决定

1. 修 F2/F3/F4：统一 exact handle 生命周期，补 A→B→A、retiring 删除、首轮关闭、迟到标题四类回归。
2. 删除 F1：窗口本地 active，清掉表、RPC、队列和旧测试；同步补双窗口/两会话执行隔离。
3. 修 F5/F6：每 Session 一条可替换投影路径；快照失败继续恢复，不创造新的执行权威。
4. 按用户要求保留 Codex 链路；Artifact/adoption/manifest 不按引用数量直接删除。只收敛已证明有等价有效路径的内部重复接口，并核实未接通的能力；handler 完整性检查须明确区分保留的待修能力。
5. 修 F8/F9/F10，并补恢复身份与 capture 上限；涉及工具、记忆和角色上下文的修改按 AGENTS.md 运行真实模型回归。

**发布决定：不予批准。** 这是对当前基线的工程审计，不是完整发布验收。存在已复现的数据/资源生命周期缺陷和硬约束违背，且发布门禁尚未执行。可以在此分支进入上述收敛工作，不能宣称执行核心已最小化或仅凭现有绿色测试发布。
