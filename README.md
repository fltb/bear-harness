# 白熊客栈 / Bear Harness

白熊客栈是一个围绕 [Pi Coding Agent](https://github.com/badlogic/pi-mono) 构建的本地桌面角色产品。Pi 负责会话内容和执行，Bear 负责角色包、角色运行目录、会话资源、记忆、外部工作与结果展示。极昼（Jizhou）是随产品交付的默认角色包，不是产品框架本身。

Electron 是生产外壳；WebDev 是本地开发和端到端验收环境，不是公开 Web 服务。

## 快速开始

要求 Node.js `24.19.0` 和 npm `11.17.0`。

```sh
npm install
npm run dev:web
```

WebDev 会输出实际使用的本地地址，通常从 `http://127.0.0.1:3200` 开始探测。它只监听回环地址，并使用进程级令牌保护 Host 接口。

启动桌面开发版：

```sh
npm run dev --workspace @bear-harness/desktop
```

## 产品边界

- Pi 是对话、消息、分支、模型历史、流式状态、队列、工具执行及会话生命周期事件的唯一权威。
- Bear 管理真实的 Pi `AgentSession` 句柄，可以并发打开、显式路由、关闭、改名、归档和删除会话，但不会复制一套 Pi 状态机。
- `active` 只是一个窗口当前显示的会话；`open` 表示 Host 持有真实会话句柄；`running` 和 `streaming` 来自 Pi。切换界面不会停止后台会话。
- Character 和 Display 使用同一套角色数据库事务与响应式快照。Character 只有 `global`（当前用户与角色）和 `conversation` 两种顶层作用域；Display 只属于会话。
- System Settings 负责供应商、模型池、网络和 embedding；Character Onboarding 只负责新角色的第一次见面、关系、记忆许可和角色默认模型。
- 显式记忆写入 `MEMORY.md`；自动 TDAI 记忆按角色独立保存。embedding 设置和模型缓存是系统级，向量、索引和记录是角色级。
- 外部工作由 External Run 管理。生成文件是归属于 Run 的 Artifact，经过所有权、路径、MIME、大小和哈希验证后进入角色自己的 CAS。

详细所有权和数据流见[系统架构](docs/refernece/architecture.md)。

## 本地数据布局

角色包和角色运行数据物理分离；每个角色的运行时文件与设置位于一个独立目录中：

```text
<dataRoot>/
  system/
    settings.db
    security/
    providers/
    models/embeddings/
    updates/
  characters/<companionId>/
    character.yaml
    STORY.md
    assets/
    canon/
    plugins/
    skills/
  companions/<companionId>/
    runtime.db
    sessions/
    memory/MEMORY.md
    memory/tdai/
    runs/<runId>/
    artifacts/<sha256>
    audit/
    diagnostics/
```

旧平面布局只允许经过一次性、失败关闭的迁移进入这棵目录树；迁移完成后没有双读、双写或旧路径回退。

## 工作区

| Workspace | 职责 |
| --- | --- |
| `@bear-harness/schema` | Zod 约束、推断和 JSON Schema 辅助能力 |
| `@bear-harness/protocol` | 有界 RPC、响应包、持久产品事件和 Pi 临时事件协议 |
| `@bear-harness/companion-client` | 对 Electron IPC / WebDev HTTP 保持中立的类型化客户端 |
| `@bear-harness/host-runtime` | Pi 会话 Registry、系统/角色存储、Character/Display、记忆、Runs、Artifacts、安全与审计 |
| `@bear-harness/tdai-core` | 自动关系记忆的本地/远端检索与处理核心 |
| `@bear-harness/companion-ui` | SolidJS 响应式投影、双层设置、会话、工作进度和结果工作区 |
| `@bear-harness/product-config` | 构建时产品身份、品牌和发行配置 |
| `@bear-harness/i18n` | 产品界面文案；角色文案仍由角色包拥有 |
| `@bear-harness/desktop` | Electron 隔离、原生凭据、文件选择、Artifact 动作、诊断和打包 |
| `@bear-harness/web-dev` | 本地浏览器 Host、HTTP 传输和 Playwright 验收 |

默认角色包入口是 [`config/characters/jizhou/character.yaml`](config/characters/jizhou/character.yaml)。创建或导入角色包前请阅读[角色包创作指南](docs/character-package-authoring.md)。

## 开发命令

```sh
npm run dev:web
npm run dev --workspace @bear-harness/desktop
npm run lint
npm run typecheck
npm run test:unit
npm run test:coverage
npm run build
```

主要验收命令：

```sh
npm run test:e2e:web:required
npm run test:e2e:web:live
npm run test:e2e:electron
npm run test:release:recovery
npm run test:e2e:packaged
npm run test:diagnostics:crash
npm run audit
```

`npm run check` 汇总 lint、typecheck、覆盖率、构建和 WebDev E2E；`npm run check:electron` 汇总桌面构建、Electron E2E 与崩溃诊断。完整 `npm run release:gate` 只在受保护的 `CI=true` 发布矩阵中运行，不能用一次本地构建代替。

平台包：

```sh
npm run package:mac:arm64
npm run package:mac:x64
npm run package:win
npm run package:linux
```

发布前必须使用同一个干净提交完成要求的平台矩阵、真实模型验证、签名/证明和 packaged smoke；公开分发还需要平台签名及 notarization。详见[开发与发布验证](docs/development-verification.md)。

## 结果工作区

Run 启动不会强制分栏；进度留在会话时间线和“当前工作”区域。Run 完成只提示结果可用。用户选择完成的 Run 或 Artifact 后才打开结果工作区：

- `>= 1600px`：会话与预览双列；
- `768..1599px`：右侧抽屉；
- `<= 767px`：全屏结果页。

Artifact 支持元数据、安全预览、打开、在文件管理器中显示、另存为，以及来源/证据。Renderer 只提交不可变 ID；Host 校验 `conversation -> run -> artifact` 所有权和内容完整性，绝不把内部 CAS 路径暴露给 Renderer。

## 安全原则

- Renderer、角色包、模型和外部执行器都不是应用状态权威。
- 普通本地输入文件留在原绝对路径；选择器把路径作为普通用户文本交给 Pi，不创建 Host 上传副本或隐式生命周期。
- 生成输出只通过 Run-owned Artifact 边界进入产品，并按角色隔离。
- API secrets 保存在平台凭据库；普通 RPC、日志和诊断不会返回秘密或内部路径。
- WebDev 的回环令牌是开发边界，不是互联网用户认证；不要将 WebDev Host 暴露到网络。
- Desktop 使用 context isolation、sandbox、关闭 Node integration，并在 main 进程验证 IPC 来源和所有原生动作。

## 文档

- [参考索引](docs/refernece/index.md)
- [系统架构与数据流](docs/refernece/architecture.md)
- [Host Runtime](docs/refernece/host-runtime.md)
- [Companion UI](docs/refernece/companion-ui.md)
- [Protocol / Schema](docs/refernece/protocol-schema.md)
- [Desktop](docs/refernece/desktop.md)
- [WebDev](docs/refernece/web-dev.md)
- [Character / Display 权威](docs/host-state-authority.md)
- [角色包创作](docs/character-package-authoring.md)
- [开发与发布验证](docs/development-verification.md)

目录名 `docs/refernece/` 是仓库现有路径，修改链接时保持一致。

## 许可证

- 代码使用 [GNU GPL-3.0](LICENSE)。
- 白熊客栈、极昼及相关文字/视觉资产使用 [CC BY-SA 4.0](BRAND-LICENSE)；该许可不授予商标权或暗示背书。
- `@bear-harness/tdai-core` 的上游代码按其记录的 [MIT 许可证](packages/tdai-core/LICENSE) 分发。
