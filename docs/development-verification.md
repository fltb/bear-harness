# 开发与发布验证

## 日常开发

从最窄的 owning package 开始，再扩大范围：

```sh
npm run lint
npm run typecheck
npm run test:unit
npm run test:coverage
npm run build
```

WebDev 是默认交互验证入口：

```sh
npm run dev:web
npm run test:e2e:web:required
```

不要把 schema/unit 测试当作 UI 验收。影响会话、流式、onboarding、Run、Artifact 或响应式布局的改动需要浏览器真实点击和视口验证。

## 定向测试

```sh
npm run test:unit --workspace @bear-harness/host-runtime
npm run test:unit --workspace @bear-harness/companion-ui
npm run test:unit --workspace @bear-harness/desktop
npm run test:release:recovery
```

关键覆盖面：

- 多个真实 Pi Session 并发、same-id open 去重和 event isolation；
- stream 中切换 active，不 abort 后台 Session；
- external result 按 origin conversation + runId 投递和幂等；
- rename/archive/delete 不依赖选择状态；
- system/characters/companions 路径和数据库隔离；
- Artifact ownership、hash corruption、bounded read 和 native action；
- system onboarding 与 character onboarding 分层；
- Character `x-scope` enum、Display conversation scope 和单事务提交。

## WebDev 真实交互

自动化与人工验收都应覆盖：

1. System Settings 完成 provider/model/network/embedding；
2. 创建新角色，只进入角色第一次见面与 consent/route；
3. 启动两个会话并同时生成；
4. 流式过程中反复切换会话，确认 token/tool/queue/error 不串线；
5. 后台 Run 完成但不抢焦点；
6. 点击结果后展示 Artifact metadata、preview、provenance 和 Web download；
7. 检查三个结果 workspace breakpoint；
8. rename、archive、restore、delete 精确作用于目标会话；
9. 重启并检查 Catalog、角色设置、memory 和 Run recovery。

## Desktop 与恢复

```sh
npm run check:electron
npm run test:e2e:packaged
npm run test:release:recovery
npm run test:diagnostics:crash
```

Desktop 额外验证 IPC sender/frame/origin、credential vault、local file picker、Artifact open/reveal/save-as、presentation copy cleanup、窗口销毁后的 subscription cleanup 和平台更新策略。

恢复验收还要覆盖：损坏 `settings.db` 后进入独立 Recovery 并重建重启；当前角色 `runtime.db` 重建；非默认角色包切回默认角色；默认角色包从 seed 恢复；清空事务在每个目录移动阶段被 kill 后可继续。另设反向用例，证明非当前角色库/包和单个坏 transcript 不会触发全局 Recovery。

## Release gate

`npm run release:gate` 只允许在受保护的 `CI=true` 矩阵运行。它覆盖 lint、typecheck、coverage、build、recovery、Web required E2E 和 Electron E2E；发布工作流还必须提供：

- `npm audit --audit-level=high` 与 `npm audit signatures`；
- 真实 provider/model 的 live E2E；
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

这些摘要和 SBOM 是可核验的构建证据，不是代码签名。没有平台证书、签名和 notarization 时，公开发行仍然是 **NO-GO**，不得用 attestation 替代或宣称已经签名。

## 审计报告证据

最终工程报告至少记录：

- 每个模块的 production/test/file/physical-line counts；
- authority、模块分层和读写数据流；
- system/character 数据与物理路径边界；
- 删除、恢复和 Artifact 完整性证据；
- lint/typecheck/test/coverage/build/E2E/package 的命令、提交和结果；
- 残余风险、外部先决条件与明确 GO/NO-GO。
