# 开发与发布验证

## 日常开发

相关源码、fixture 和文档修复先集中完成，再统一运行验证门禁。汇总失败后成批修正，不逐点反复重跑，也不在没有具体修正时重跑同一失败测试。所有 Node/npm 命令使用 `.nvmrc` 选定的工具链：

```sh
fnm exec --using=.nvmrc npm run lint
fnm exec --using=.nvmrc npm run typecheck
fnm exec --using=.nvmrc npm run test:unit
fnm exec --using=.nvmrc npm run test:coverage
fnm exec --using=.nvmrc npm run build
```

WebDev 是默认交互验证入口：

```sh
fnm exec --using=.nvmrc npm run dev:web
fnm exec --using=.nvmrc npm run test:e2e:web:required
```

不要把 schema/unit 测试当作 UI 验收。影响会话、流式、onboarding、Run、Artifact 或响应式布局的改动，需要在真实浏览器中直接读取 DOM，验证可访问 landmark、控件、真实点击、状态转换和视口边界。截图、截图比较、基线更新和图片目测不作为验收或发布证据；README 宣传截图仅用于展示，与工程验收分开，不能替代任何必需门禁。

## 定向测试

```sh
fnm exec --using=.nvmrc npm run test:unit --workspace @bear-harness/host-runtime
fnm exec --using=.nvmrc npm run test:unit --workspace @bear-harness/companion-ui
fnm exec --using=.nvmrc npm run test:unit --workspace @bear-harness/desktop
fnm exec --using=.nvmrc npm run test:release:recovery
```

内存受限的本地机器可限制 UI worker 数量；仍运行完整测试集合并保留原覆盖率门槛：

```sh
fnm exec --using=.nvmrc npm exec --workspace @bear-harness/companion-ui -- vitest run --coverage --maxWorkers=2
```

关键覆盖面：

- 多个真实 Pi Session 并发、same-id open 去重和 event isolation；
- stream 中切换 active，不 abort 后台 Session；
- external result 按 origin conversation + runId 投递；原会话忙碌时可原生排队，但只有已持久化的 native custom-message entry 才确认送达；
- rename/archive/delete 不依赖选择状态；
- system/characters/companions 路径和数据库隔离；
- Artifact ownership、hash corruption、bounded read 和 native action；
- system onboarding 与 character onboarding 分层；
- Character `x-scope` enum、Display conversation scope 和单事务提交。
- 模型生成工具参数时即可通过原生 disclosure 检查部分参数，真实点击验证展开/收起及展开状态跨执行和持久化保持，不冒充工具已经执行；
- 已完成 onboarding 在启动权威状态尚未加载时不闪现：观察 DOM 挂载过程，而不只检查加载完成后的页面；真正未完成的用户仍进入对应层，后台刷新不丢表单草稿；
- 长任务证据可以实际点击和滚动，不被输入框遮挡；媒体弹层与 Artifact 工作区保持独立，不按图片 MIME 合并所有权，打开媒体不关闭已打开的结果；这些选择仅属于 UI-local，切换会话清除旧选择。

## WebDev 真实交互

验收直接检查真实渲染后的 DOM 和可访问语义，不断言源码文本或无关文案，也不用 jsdom 可见性代替浏览器指针可达性。自动化优先通过 role、accessible name 和 landmark 定位，执行正常点击、键盘与滚动，再读取控件状态、展开/关闭状态及焦点；不得用强制点击、固定等待或放宽断言掩盖交互问题。

在三个视口分别覆盖所有可达的站点地图状态，通过元素边界与视口/滚动容器尺寸验证响应式布局、溢出和遮挡，并以真实指针交互证明目标可达。Artifact 宽屏工作区是导航之外的“对话＋结果”双主体，常驻立绘让位；窄屏仍须能打开、操作和关闭结果。角色媒体从原生工具结果入口打开独立媒体弹层，不是 Artifact 任务证据；继续聊天或打开媒体不应意外关闭结果工作区，关闭后的焦点行为也须通过 DOM 验证。

自动化与人工验收都应覆盖：

1. System Settings 完成 provider/model/network/embedding；
2. 创建新角色，只进入角色第一次见面与 consent/route；
3. 启动两个会话并同时生成；
4. 流式过程中反复切换会话，确认 token/tool/queue/error 不串线；
5. 后台 Run 完成但不抢焦点；
6. 点击结果后展示 Artifact metadata、preview、provenance 和 Web download；
7. 在三个结果 workspace breakpoint 逐一验证可达状态、DOM 布局边界、滚动和真实交互；
8. rename、archive、restore、delete 精确作用于目标会话；
9. 重启并检查 Catalog、角色设置、memory 和 Run recovery。

## Desktop 与恢复

```sh
fnm exec --using=.nvmrc npm run check:electron
fnm exec --using=.nvmrc npm run test:e2e:packaged
fnm exec --using=.nvmrc npm run test:release:recovery
fnm exec --using=.nvmrc npm run test:diagnostics:crash
```

Desktop 额外验证 IPC sender/frame/origin、credential vault、local file picker、Artifact open/reveal/save-as、presentation copy cleanup、窗口销毁后的 subscription cleanup 和平台更新策略。

恢复验收还要覆盖：损坏 `settings.db` 后进入独立 Recovery 并重建重启；当前角色 `runtime.db` 重建；非默认角色包切回默认角色；默认角色包从 seed 恢复；清空事务在每个目录移动阶段被 kill 后可继续。另设反向用例，证明非当前角色库/包和单个坏 transcript 不会触发全局 Recovery。

恢复导出必须用规范化路径校验包含关系，防止符号链接祖先把目标指回源目录；原生文件打开失败时只清理本次拥有的展示副本，并保留原始错误。

## Release gate

`npm run release:gate` 只允许在受保护的 `CI=true` 矩阵运行。它覆盖 lint、typecheck、coverage、build、recovery、Web required E2E 和 Electron E2E；发布工作流还必须提供：

- `npm audit --audit-level=high` 与 `npm audit signatures`；
- 真实 provider/model 的 live E2E；
- 单进程、零重试的 120 分钟后台 Chromium 耐久测试；
- 非 placeholder 版本；
- 干净且唯一的 release commit；
- 每个平台从该提交新构建的包；
- packaged smoke、hash、SBOM/attestation；
- 公开发行所需的代码签名和 notarization。

任何必需阶段未运行、跳过、运行在不同提交或缺少可核对证据，release decision 都是 **NO-GO**。

发布证据按平台拆分并由 final gate 二次核验：

- `verify-package.mjs` 要求目标平台的完整安装包集合，逐个记录字节数与 SHA-256；
- 同一步使用 `npm sbom --package-lock-only --omit=dev` 生成独立 CycloneDX SBOM，并绑定根 `package-lock.json` 的 SHA-256；
- `release-attestation.mjs package` 在 packaged smoke 之后重新读取安装包、SBOM 与 lockfile，任何字节变化都会拒绝出证；
- 每个平台上传 `package-<target>.json`、`package-evidence-<target>.json` 和 `sbom-<target>.cdx.json`；final gate 校验其 commit、schema、文件摘要和完整平台集合；
- attestation 只忽略自身的 `release-attestations/` 输出目录。其他 tracked 或 untracked 变化都被视为 dirty tree，任何阶段均拒绝生成通过记录。

RC 耐久门禁固定使用三个并发 Pi Session，连续混合执行发送、流式切换、停止、编辑、历史分页、媒体查看和 Run/Artifact 工作区操作。发布报告至少证明 120 分钟、5000 轮、1000 次切换、500 次停止、10000 个权威条目、100 次历史加载、各 50 次媒体和 Artifact 交互；会话串扰、漏项/重复、停止后 token、卡流、页面/进程/持久化/归属错误和孤儿资源必须全部为零。Renderer 与 Host 每分钟强制 GC 后采样，前 10 分钟只作预热，不参与增长预算；逐点资源序列单独保存并以 SHA-256 绑定到报告，开始/中点/结束截图只作排障材料。该确定性耐久门禁与同一提交上的真实模型验收互补，不能互相替代。

这些摘要和 SBOM 是可核验的构建证据，不是代码签名。没有平台证书、签名和 notarization 时，公开发行仍然是 **NO-GO**，不得用 attestation 替代或宣称已经签名。

## 审计报告证据

最终工程报告至少记录：

- 每个模块的 production/test/file/physical-line counts；
- authority、模块分层和读写数据流；
- system/character 数据与物理路径边界；
- 删除、恢复和 Artifact 完整性证据；
- lint/typecheck/test/coverage/build/E2E/package 的命令、提交和结果；
- UI 验收所用的真实浏览器、视口、可达状态、DOM/可访问交互断言及实际结果；截图和 README 宣传图片不列为验收或发布证据；
- 残余风险、外部先决条件与明确 GO/NO-GO。
