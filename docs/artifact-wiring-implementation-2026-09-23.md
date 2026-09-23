# Artifact 接线实施报告

日期：2026-09-23。分支：`codex/execution-core-audit`。本轮基于 9 月 22 日已完成、尚未提交的核心整改继续实施；没有创建提交或发布。

## 结果与边界

已落实用户确认的 Artifact 目标结构。原审计 A1–A7 已修复，Manifest 安全展示与启动孤立文件清理已接通。采纳保留独立记录和存储能力，按约定不开放新 RPC/UI。Codex 执行链保持原状。

**核心没有新增 Artifact 业务权威。** CharacterRuntimeRegistry、Dispatcher、PiRuntime 的源码 SHA256 与上一轮核心实施证据完全一致。改变的核心接线只有角色资源开放前等待维护、关闭时等待 Artifact 资源释放、总装配调用 Artifact 模块注册。所有文件操作继续显式定位角色、会话、Run 和 Artifact。

Artifact 有自己的持久化数据和真实 IO 资源，属于 Bear 的职责；无状态控制层不保存“当前文件/当前 Run”，也不复制 Pi 的消息、运行标志、队列或完成状态。独立复查与验证明细见 [机器可读证据](evidence/artifact-wiring-implementation-2026-09-23.json)。

## 模块与数据所有权

| 模块 | 最终职责 |
| --- | --- |
| `artifacts/index.ts` | 角色 CAS、metadata、异步校验/范围读取、实际资源租用和释放、孤立文件维护 |
| `artifacts/capture.ts` | 从 Run outputs 捕获并校验文件，包含路径、MIME、文件数量和大小边界 |
| `artifacts/rpc.ts` | 注册 read/open/reveal/saveAs，验证归属、租用目标资源、通知相关查询失效 |
| `artifacts/presentation.ts` | 给可信桌面 presenter 提供临时读取与展示副本能力，操作结束即失效 |
| RunService | 决定何时捕获、记录 Run 结果、投递到指定会话；读取持久成果集合 |
| Renderer | 保存窗口本地四个身份字段，通过已有 Run 详情查询生成展示 |

沿用 ArtifactStore，没有新增平行 ArtifactService、通用工作流框架或持久事件流。ArtifactStore 的新增内存状态限于实际 Promise/句柄工作、同内容发布排斥、校验缓存和删除所需排斥。

旧混合 `status` 已由三个独立事实取代：

- `verification: pending | verified | failed`：内容校验结果。
- `saved: boolean`：桌面 presenter 确认另存成功；不保存用户目标路径。
- `adopted: boolean`：从现有 `artifact_adoptions` 关系派生，不另存布尔副本。

角色库打开时一次性转换旧表，保留 Artifact ID、内容身份、保存事实、采纳记录与 Canon/Run 外键；旧 saved/adopted 状态没有充分的当前校验证据，转换为 pending 后重新验证。服务不双读写旧 status，也不根据 saved 跳过实际文件校验。采纳重复调用不重复插入，且不再覆盖校验或保存事实；这不代表采纳产品流程已经开放。

## 缺陷修复

| 审计项 | 修复结果 |
| --- | --- |
| A1 空作用域残留 | 选择绑定稳定的本地角色 id 与会话 id；角色/会话变化或 null 均清空，关闭或切走后的迟到请求不重新打开结果 |
| A2 历史文件切换失效 | 选择只保存 `{ characterId, conversationId, runId, artifactId }`；详情由 `run.observeDetail` 提供，删除 RunInfo fallback |
| A3 保存期间误报损坏 | 分块一致性仅检查不可变内容与范围；saved/adopted 变化不造成损坏；Host 报告校验失败后隐藏已有预览 |
| A4 保存后不刷新 | 保存落库后发布现有角色级 `CacheKey.runs()`；列表、历史和详情按权威查询刷新，通知无持久化或重放 |
| A5 冷读阻塞 | 大文件范围读取与完整校验改为异步，精确文件版本共享校验；调用者取消不会取消仍有使用者的共享任务 |
| A6 首次与重试成果不一致 | 移除 TerminalRunResult 的冗余 outputs 与临时数组交付路径，首次/重试均读取已提交且验证成功的成果；部分成功文件保留，Run 仍报失败 |
| A7 历史结果缺入口 | 原生 custom result 与 delegate receipt 复用 Run 详情卡片，不要求旧 Run 出现在近期列表 |

预览/浏览器下载维持 64 MiB 上限；桌面保存继续支持捕获上限内的大文件。Web 明确显示“已开始下载”，不写入无法确认的 saved。Media 与 Artifact 保持各自展示容器。

## 资源与独立复查

Session 删除先停止目标 Run 的捕获，再通过 ArtifactStore 排斥目标 Run 的新文件操作，等待已接纳的完整 RPC/presenter 操作，最后删除 transcript、metadata 与无引用 CAS。其他 Run 可以继续访问。角色关闭取消并等待实际 IO、共享校验和租用结束后再关闭数据库。

独立复查额外找到并修复了三项资源问题：

1. 同内容捕获正在提交 metadata 时，另一个 Run 删除最后引用可能误删 CAS。现在同 hash 发布持有实际 Promise 排斥，删除跳过在途发布；同 hash 捕获也不会相互覆盖已经发布的 inode。
2. 最后一个读取者取消后，独立 verifier 句柄可能尚未关闭。现在最后使用者等待校验任务实际释放句柄，Session 删除不会越过这个等待。
3. 临时 presenter 曾保留已经成功的读取 Promise，从而累计保留分块 Buffer。现在及时移除已完成任务，仅保留首个失败供关闭时报错。

前两项使用原始并发复现分别验证修复后文件可读、删除等待真实句柄关闭。未声称执行了 Windows 平台验证。

启动维护在角色开始接纳请求/恢复 Run 之前完成：合法且无引用的 CAS 保留 7 天，合法临时文件保留 24 小时；引用文件、近期文件、目录、symlink 和未知名称不清理。正常 Session 删除仍按精确引用立即清理。本轮没有全局周期扫描器。

## Manifest 展示

`run.get.provenance` 返回最多 20 项白名单启动记录，以及 `unavailableCount`、`hasMore`。摘要包含实际 executor、profileId、launchedAt；Codex 可带其已有 version/hash，Pi 不虚构缺失信息。读取验证 Run/profile 归属，丢弃无法识别的记录并明确展示数量；原始 JSON、worker 路径及秘密不进入 Renderer。

Run 详情与结果来源区都可查看摘要。执行器写入逻辑未修改，Codex adapter 的源码摘要与审计基线相同。

## 规模

沿用 Artifact 审计的完整文件统计口径，加上两个提取的 Artifact 文件。数字含文件内非 Artifact 代码，不代表本轮独占代码量，也不把已有核心整改混算成本轮删改。

| 模块组 | 文件数（前→后） | 行数（前→后） |
| --- | ---: | ---: |
| Artifact 存储与呈现 | 2→4 | 925→1,566 |
| Run 与执行器 | 3→3 | 2,536→2,423 |
| Host 装配与会话 | 5→5 | 3,636→3,550 |
| 协议与数据结构 | 2→2 | 3,211→3,232 |
| UI 与客户端投影 | 7→7 | 6,313→6,381 |
| 桌面与 Web 入口 | 3→3 | 1,455→1,455 |
| 合计 | 22→24 | 18,076→18,607 |

跟踪范围净增 531 行，主要为真实异步 IO、资源释放与维护边界；Run 与 Host 装配合计减少 199 行。数据库转换、SQL schema、窗口来源展示、文案和测试等支持性文件另列于证据，不以净删行数代替架构收敛判断。

## 验证

所有 Node/npm 命令均使用 `.nvmrc` 对应 fnm 工具链。最终定向测试不与全量测试重复计数。

- lint、全仓 typecheck、桌面/Web build：通过。
- Host：71 文件、653 通过、2 跳过；语句/分支/函数/行覆盖率 79.66% / 69.76% / 81.39% / 83.12%。
- UI：37 文件、280 通过、1 跳过；覆盖率 80.56% / 70.23% / 80.72% / 83.90%。
- Desktop：23 文件、207 通过；覆盖率 86.18% / 76.08% / 92.93% / 89.52%。
- 协议 19、i18n 12、TDAI 8、仓库脚本 24、WebDev unit 13 通过；合计 **1,216 unit 通过、3 跳过**。
- Artifact 与双角色/双窗口真实 Web 定向操作：9/9 通过；包括实际 Pi worker 生成、下载内容验证、响应式工作区、后台结果路由、暂停恢复和失败详情。
- Electron：4/4 通过。
- 最终 Web required hosted 功能集合：67 通过、2 个 live-model 项跳过；包含新增 Manifest 与 Web 下载语义断言。
- Recovery：Host 51 + Desktop 24，合计 75/75 通过。

初次本机服务测试受到沙箱 loopback 监听限制，已通过所需本机测试权限重跑；修改中的失败已修复后重跑，未算作最终通过。安全审计按用户指示暂不继续。

## 剩余边界与发布决定

采纳入口按确认范围保留未开放；Codex 执行链留待用户后续处理。这里的 GC 是启动维护，长时间不重开的角色不会周期回收孤立文件。Web 不能确认用户最终保存到磁盘，桌面保存才更新 saved。

真实模型前置检查因未设置 `BEAR_E2E_LIVE_MODEL=1` 未通过，未执行 live-model 验收；确定性测试 provider 不代替真实模型验收。完整性能/视觉基线不由 hosted 功能集合替代；前次核心报告中已有的视觉基线差异未通过更新截图掩盖。没有生成同一干净提交的全平台新包或 packaged smoke。

**发布决定：本轮交付源码整改和回归证据，不作发布批准。**
