# Desktop

## 进程边界

`@bear-harness/desktop` 是生产外壳：

```text
Electron main
  ├─ HostRuntime + system/companion storage
  ├─ credential vault / update / diagnostics / recovery
  ├─ native local-file picker
  └─ Artifact presenter (open/reveal/save-as)
        │ validated IPC + Pi push
Preload │ frozen, narrow bridge
        ▼
Sandboxed renderer -> CompanionClient -> Companion UI
```

main 入口位于 [`apps/desktop/src/main/index.ts`](../../apps/desktop/src/main/index.ts)，IPC router 位于 [`apps/desktop/src/main/ipc-router.ts`](../../apps/desktop/src/main/ipc-router.ts)，preload 位于 [`apps/desktop/src/preload/index.cts`](../../apps/desktop/src/preload/index.cts)。

Renderer 启用 context isolation 和 sandbox，关闭 Node integration；它不导入 Electron 或 Node 模块。

## 启动

1. 在 renderer 创建前确定 product-scoped data root；
2. 完成/恢复一次性目录迁移；
3. 建立凭据、diagnostics、recovery 和 update 服务；
4. 创建并启动 HostRuntime；
5. 注册 versioned RPC、durable event、Pi transient event 及 native action handlers；
6. 创建 main window 并只接受固定 source/E2E 或 loopback dev origin。

shutdown 先停止新 IPC，清理 window listeners 与 push subscriptions，再关闭 HostRuntime 和 diagnostics。窗口销毁必须撤销属于该 Renderer 的临时资源。

## IPC

普通 RPC 使用 shared protocol registry，并由 main 验证：

- 调用来自已注册 BrowserWindow；
- frame 是允许的 main frame；
- URL 精确匹配构建模式；
- request/response 通过 schema；
- runtime 已启动且未关闭。

durable event 与 Pi live event 使用两个独立 push channel；后一种不写数据库。每个 listener 有随机本地 id，unlisten、window destroy 和 teardown 都会释放它。

## 本地输入文件

本地 picker/drop 是特权 main 功能，不是普通 Renderer path RPC。main 限制选择数量、绝对路径长度、文件类型和 containment，然后把经过验证的原绝对路径作为普通用户文本返回给 composer。Host 不创建 upload id、文件副本、message binding 或额外生命周期；Pi 使用其原生只读工具读取普通文件，结构化办公文件可交给无状态 `document_read` Host tool。

## Artifact 原生动作

Renderer 只传 `{conversationId, runId, artifactId}`：

- Host 先验证所有权和 SHA-256；
- open/reveal 使用安全 filename 的 presentation copy 或 opaque capability；
- Save As 在 main 显示原生目标 picker，并从已验证内容写入选择的位置；
- cancelled 与 unsupported 是正常 outcome；
- 不向 Renderer 返回 CAS path 或 Save As 目标 path。

## Credential、diagnostics 与 updates

API secrets 通过 injected credential vault 读写；settings DB 只保存 provider/model 的非秘密配置。诊断默认脱敏、有界并按角色写入 `companions/<id>/diagnostics`，系统诊断不得包含角色内容。

更新下载、hash、签名和 publisher policy 必须保持一致。代码存在 staged update 不等于允许公开分发；发布包仍需平台签名、macOS notarization 和同提交 smoke 证据。

## 开发与打包

```sh
npm run dev --workspace @bear-harness/desktop
npm run build --workspace @bear-harness/desktop
npm run test:unit --workspace @bear-harness/desktop
npm run test:e2e:electron
npm run test:diagnostics:crash
```

```sh
npm run package:mac:arm64
npm run package:mac:x64
npm run package:win
npm run package:linux
```

package output 位于 `apps/desktop/release/`。每个平台需要新构建和 packaged smoke，不能用另一平台或旧产物替代。
