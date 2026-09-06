# 白熊客栈 / Bear Harness

[English](README.md) · **简体中文**

**有角色、有记忆，也有真实 Agent 能力的本地桌面伙伴。**

在极光书房里聊聊今天，也让对话接上真实的工具与工作。白熊客栈把角色的表达、可延续的记忆与 [Pi Coding Agent](https://github.com/earendil-works/pi) 放进同一个桌面界面：有陪伴的温度，也保留任务执行应有的边界与证据。

随仓库提供的默认角色是 **极昼（Jizhou）**。他是一个完整的角色包，而不是整个框架；你也可以创作和导入自己的角色、场景、资料与技能。

![白熊客栈的真实会话界面：极昼、极光书房与演示对话](docs/screenshots/conversation.webp)

*截图已从实际运行的隔离 WebDev 界面重新拍摄，视口为 1440×850，回复来自预先编写的回环（loopback）provider。它不是真实模型验证，也不是文件修改证据。极昼角色包的对话内容为中文。*

## 不止是一个聊天窗口

### 让角色有自己的世界

角色包拥有身份设定、背景资料、立绘、场景、媒体和技能。极昼的极光书房只是一个起点；界面与角色内容分开，让新的伙伴不必重新造一套应用。

### 让多段对话各有位置

消息、分支、流式回复、工具执行与队列由真实的 Pi 会话驱动。界面保留原生工具名称、参数、结果、错误与可见 custom 内容，并显式加载更早原生历史，不另造合成聊天记录。可以打开多个会话、切换查看，并分别管理名称与归档；切换界面不会停止后台会话。Bear 管理资源与路由，不另外拼装一套执行状态机。

### 让相处可以延续

显式笔记写入 `MEMORY.md`，关系记忆也按角色独立保存。embedding 为可选配置，成功配置系统级 embedding 后即可启用关系记忆；角色之间不共用记忆记录，新角色也不必重复配置供应商、网络。检索失败或不可用不会冒充“搜索成功但没有命中”；诊断仅保留有界、脱敏的角色本地记录。

### 让工作与结果有据可查

新委派只使用内置 Pi Worker：Run 记录执行，Artifact 承载输出，Host 校验归属与完整性。当前角色跨会话的工作列表、分页历史与任务详情展示真实状态、活动、证据、回报情况和产物；引导、中断、继续、取消、权限响应与重试回报只按 Host 实际提供的能力开放，不编造进度。点击对应成果按钮才打开结果工作区；角色媒体使用独立弹层，不会冒充任务成果。

### 让模型选择留在你手里

供应商和模型池在系统设置中集中管理，角色默认模型与会话模型路由各有边界。调整模型选择不必重新配置整个角色；使用哪项服务、数据会发往哪里，也应由你的配置决定。

## 看看实际界面

### 从对话打开角色媒体

角色媒体在原生对话位置显示缩略图或播放入口，点击后打开独立媒体弹层。CG 保留完整构图，可以展开或按原始尺寸查看；关闭后回到对话，不会关闭底下已经打开的结果区。

![极昼角色媒体的独立展示弹层](docs/screenshots/media-preview.webp)

*同一隔离应用中重新拍摄的 1440×850 媒体视图。入口来自预先编写的 loopback provider 驱动的真实 `host_media` 原生工具结果，不是真实模型能力证明，也不是任务 Artifact。*

Run 成果有自己的结果入口。宽屏下，点击成果后形成“对话＋结果”两列，大块立绘区让位；较窄窗口采用抽屉或全屏结果页。Run 完成只提示结果就绪，不自动切换布局。

任务选择属于当前角色，可跨会话保留；Artifact 选择属于具体会话，查看其他会话的产物必须由用户显式点击并完成导航。后台任务不会抢焦点、切换会话或自行打开结果。Run 完成与结果送达分别记录：只有原 Pi 会话持久化了对应 native custom message 才确认送达，排入 follow-up 队列不算。重试回报不重新执行任务；请求再次执行会作为普通消息交给 Pi。

### 窄屏也能继续阅读

<p align="center">
  <img src="docs/screenshots/conversation-mobile.webp" width="320" alt="白熊客栈 WebDev 会话界面的窄屏响应式布局" />
</p>

*重新拍摄的 390×1100 WebDev 窄屏响应式视图，同样使用隔离的预编写 provider 与中文极昼对话。这里展示的是浏览器布局，不是原生手机应用，也不是执行证据。*

## 从源码开始

需要 **Node.js `24.19.0`**、**npm `11.17.0`** 和 [fnm](https://github.com/Schniz/fnm)。在仓库根目录执行：

```sh
fnm install
fnm exec --using=.nvmrc npm install
fnm exec --using=.nvmrc npm run dev:web
```

打开终端输出的本地地址，通常从 `http://127.0.0.1:3200` 开始探测可用端口。

启动 Electron 桌面开发版：

```sh
fnm exec --using=.nvmrc npm run dev --workspace @bear-harness/desktop
```

首次使用时，在系统设置中配置供应商凭据、回复模型与所需网络选项；也可选择配置本地或远程 embedding 来启用关系记忆。随后完成角色的第一次见面，再开始会话。新角色无需重复进行系统配置。

**Electron 是桌面产品外壳；WebDev 是本地开发与交互验收入口。** WebDev 只监听回环地址，不是可直接部署到公网的 Web 服务。这里提供的是源码运行方式，不代表已有签名安装包可下载。

## 温度留给角色，事实交给运行时

| 层 | 负责什么 |
| --- | --- |
| Pi | 消息、分支、模型历史、流式状态、工具、队列与执行生命周期 |
| Bear Host | 真实会话资源归属与路由、角色包及角色数据作用域、记忆、Run 生命周期与持久回报跟踪、Artifacts 及安全边界 |
| Companion UI | 展示 Host 与 Pi 的权威数据，提供角色、会话与结果的交互界面 |
| Electron / WebDev | 桌面原生能力 / 本地回环开发环境 |

角色包与运行数据物理分离：系统配置集中管理，各角色的会话、记忆和产物分别存储。角色表达不能改写任务状态、权限或成功判定。UI 不乐观更新 Host-backed 业务状态，只采用成功的 Host response 或刷新后的权威 Query。新委派没有 agent 选择器、默认执行器设置或自动 Codex fallback；Pi accepted receipt 标识已接纳的 Run，不代表任务完成。

架构、工作区划分与本地数据布局见[参考索引](docs/refernece/index.md)、[系统架构](docs/refernece/architecture.md)和 [Host Runtime](docs/refernece/host-runtime.md)。

### 本地运行，不等于完全离线

- 使用远程模型、embedding 或其他外部服务时，请求中的数据可能离开本机；请按供应商政策与自己的需求选择配置。
- Renderer、角色包、模型和外部执行器都不是应用状态的权威；原生动作与产物访问由 Host 校验。
- 桌面端使用平台凭据库保存 API secrets，并采用 context isolation、sandbox 与禁用 Node integration 的隔离边界。
- WebDev 的进程级令牌只保护本地开发接口，不是互联网用户认证。不要将 WebDev Host 暴露到网络。

更多边界见 [Desktop](docs/refernece/desktop.md)、[WebDev](docs/refernece/web-dev.md)与 [Character / Display 权威](docs/host-state-authority.md)。

## 创作与开发

- **做自己的角色**：[角色包创作指南](docs/character-package-authoring.md) · [极昼角色包入口](config/characters/jizhou/character.yaml)
- **了解界面与协议**：[Companion UI](docs/refernece/companion-ui.md) · [Protocol / Schema](docs/refernece/protocol-schema.md)
- **理解记忆实现**：[TDAI Core](docs/refernece/tdai-core.md)
- **参与工程开发**：[开发与发布验证](docs/development-verification.md)——开发命令、测试、平台打包、恢复验收与发布门禁。

```sh
fnm exec --using=.nvmrc npm run check
fnm exec --using=.nvmrc npm run check:electron
```

上面的检查分别覆盖 WebDev 与桌面开发流程，不替代受保护 CI 中的完整发布矩阵、平台签名和 packaged smoke 验收。

## 许可证与署名

- **代码**：[GNU GPL-3.0](LICENSE)。
- **白熊客栈、极昼及相关文字与视觉资产**：[CC BY-SA 4.0](BRAND-LICENSE)，署名 **fltb — 白熊客栈 / Bear Harness Brand Assets**。截图中的角色与场景资产来源见[资产溯源说明](config/characters/jizhou/assets/PROVENANCE.md)。改编须注明修改并遵守相同方式共享要求；许可不授予商标权，也不表示作者背书。
- **`@bear-harness/tdai-core` 上游代码**：按其记录的 [MIT 许可证](packages/tdai-core/LICENSE) 分发。
