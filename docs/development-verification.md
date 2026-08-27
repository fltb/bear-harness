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
- 默认使用当前用户数据目录下的产品专属 data directory；可用 `BEAR_WEB_DEV_DATA_DIR` 显式指定另一处目录。

页面右下角的 **Web Dev** 面板可：

- 在用户打开系统设置后才读取模型服务目录；启动和首次引导不会主动请求 Pi 配置。
- 使用机器本地 AES-GCM vault 保存 API key。默认密钥文件权限为 `0600`；也可通过 `BEAR_WEB_DEV_MASTER_KEY` 注入开发环境密钥。
- 支持 API key 服务和浏览器/设备码 OAuth 登录；OAuth 授权页在浏览器中完成，Host 会话持续轮询其结果。
- 调用当前 Host 注册的任意 RPC channel，并显示原始 response envelope。

`npm run check` 包含 lint、typecheck、coverage、两套应用 build 与 `test:e2e:web`；它不启动 Electron。

## 本地追踪与日志等级

Host 诊断采用 `TRACE / DEBUG / INFO / WARN / ERROR / FATAL` 等级，默认是 `INFO`。人工全流程测试需要显式以 `BEAR_LOG_LEVEL=trace npm run dev:web` 启动；`TRACE` 才会记录经过脱敏和 4096-byte 限长的用户、Host 上下文、模型回复及工具输入输出。API key、token、密码和真实本机路径会先被替换。正式打包应用会把 `TRACE` 强制收紧为 `DEBUG`，因此不能通过环境变量让发布包持久化会话内容。

一次对话回合以 `companion.turn` 为根，模型路由/请求、Context Pack、Skill 读取、工具执行、Host 规则与状态切换、外部代理生命周期都沿用同一 trace id。RPC 是其上游父 span；外部代理回调与重启恢复通过持久化 trace context 续接，不以进程内异步上下文侥幸维持。

构建 Host 后可把最近一次完整回合原子导出为本地 JSON 证据：

```bash
npm run diagnostics:export -- \
  --root <data-directory>/diagnostics \
  --latest-turn \
  --output <local-report-directory>/latest-turn.json
```

也可用 `--trace <32位trace-id>` 精确导出。查询只读取诊断目录内受控命名的 JSONL，逐条复验契约，忽略并统计损坏/半写入行；不会上传或创建网络端报告。

## 交互契约覆盖

`apps/web-dev/e2e/settings.spec.ts` 使用真实 HTTP Host 验证：

| 交互 | 断言 |
| --- | --- |
| 首次见面 | 双击只提交一次；步骤在 500 ms 后仍保持为 Host 返回的下一步；完整流程会创建首个对话。 |
| 对话 | 新建和选择对话更新真实 Host projection 与侧栏选中状态。 |
| 幕后与设置 | 工作队列开合；drawer/tab 导航；关系记忆开关真实持久化并重新读取。 |
| Web Dev | 枚举每个注册 RPC channel，并发送一次 authenticated 真 Host 调用。 |
| 日常入口 | 搜索真实过滤会话；材料以文本内容随消息提交；关系档案、故事档案、角色管理、系统设置均使用真实 Host 数据。 |
| Canon Hub | 高级角色包工坊可加入原作资料、检索分段原文、建立可编辑的层级剧情模块；根入口与当前话题相关模块会进入 Context Pack。 |
| 工作闭环 | 角色提出的行动必须先展示读写/联网范围；完成后获准写入的普通文件会作为可下载成果登记。 |

`packages/companion-ui` 单元测试覆盖 UI 到 transport 的参数契约：composer 的提交/Shift+Enter、消息版本/再生成/编辑/继续/分支、记忆批准/置顶/搜索，以及旧 snapshot 与跨 renderer stale submit 的恢复。

系统设置包含有真实 Host effect 的关系记忆和模型服务选择。普通用户入口不展示原始 prompt、module、scope 或 provider runtime 等实现术语；这些只在角色包工坊和模型设置中按需出现。

## Electron：发布前验证

Electron 仍是唯一生产壳。它负责 preload/context isolation、safeStorage、Crashpad、file/asar、原生窗口和安装包；WebDev 不替代这些验证。

本机需要验证原生壳时：

```bash
npm run check:electron
npm run package:linux
npm run test:e2e:packaged
```

macOS 和 Windows 使用对应的 `package:mac` / `package:win`。CI 在每个 push/PR 同时运行 WebDev 完整旅程和 Electron source smoke；只有原生 package、Crashpad smoke 与 packaged-app smoke 保留在 `workflow_dispatch` 或 published release。
