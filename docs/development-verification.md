# 开发验证

## 默认路径：WebDev

日常开发和功能 E2E 默认使用真实的 loopback Host 与浏览器 UI，而不是 Electron：

```bash
npm run dev:web
npm run check
```

`npm run dev:web` 启动：

- Rsbuild 浏览器入口：`http://127.0.0.1:3200`
- 同一 `HostRuntime` 的 loopback HTTP transport：`127.0.0.1:3201`
- 角色包：`config/characters`
- 随机 bearer token；HTTP Host 只绑定 loopback
- 默认临时 data directory；需要跨重启保留调试状态时，显式传入 `BEAR_WEB_DEV_DATA_DIR`

页面右下角的 **Web Dev** 面板可：

- 在用户点击“加载模型配置”后才读取 Pi provider catalog；启动和首次引导不会主动请求 Pi 配置。
- 将 API key 仅写入当前 WebDev 进程的 session-only vault。
- 调用当前 Host 注册的任意 RPC channel，并显示原始 response envelope。

`npm run check` 包含 lint、typecheck、coverage、两套应用 build 与 `test:e2e:web`；它不启动 Electron。

## 交互契约覆盖

`apps/web-dev/e2e/settings.spec.ts` 使用真实 HTTP Host 验证：

| 交互 | 断言 |
| --- | --- |
| 首次见面 | 双击只提交一次；步骤在 500 ms 后仍保持为 Host 返回的下一步；完整流程会创建首个对话。 |
| 对话 | 新建和选择对话更新真实 Host projection 与侧栏选中状态。 |
| 幕后与设置 | 工作队列开合；drawer/tab 导航；关系记忆开关真实持久化并重新读取。 |
| Web Dev | 枚举每个注册 RPC channel，并发送一次 authenticated 真 Host 调用。 |
| 未交付入口 | 搜索、侧栏“关系档案/系统设置”和材料导入必须禁用，不能伪装成已接通的功能。 |

`packages/companion-ui` 单元测试覆盖 UI 到 transport 的参数契约：composer 的提交/Shift+Enter、消息版本/再生成/编辑/继续/分支、记忆批准/置顶/搜索，以及旧 snapshot 与跨 renderer stale submit 的恢复。

当前设置页只保留有真实 Host effect 的**关系记忆**。沉浸程度、场景和主题之前只回显临时值，不会改变 Host 或界面；已删除，而不是保留误导性的可点击控件。

## Electron：发布前验证

Electron 仍是唯一生产壳。它负责 preload/context isolation、safeStorage、Crashpad、file/asar、原生窗口和安装包；WebDev 不替代这些验证。

本机需要验证原生壳时：

```bash
npm run check:electron
npm run package:linux
npm run test:e2e:packaged
```

macOS 和 Windows 使用对应的 `package:mac` / `package:win`。CI 只在 `workflow_dispatch` 或 published release 运行 source Electron E2E、原生 package、Crashpad smoke 和 packaged-app smoke；push/PR 的默认浏览器 E2E 是 `test:e2e:web`。
