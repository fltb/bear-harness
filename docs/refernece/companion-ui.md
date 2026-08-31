# Companion UI

## 边界

`@bear-harness/companion-ui` 是 SolidJS Renderer。它通过 `CompanionClient` 读取和修改 Host 产品域，并直接投影 Pi snapshot/live events。它不读取 Host 数据库、Pi transcript、角色目录或内部 CAS。

入口位于 [`packages/companion-ui/src/App.tsx`](../../packages/companion-ui/src/App.tsx)，主要 store 位于 [`packages/companion-ui/src/stores/companion.tsx`](../../packages/companion-ui/src/stores/companion.tsx)。

## UI 可以拥有的状态

- 当前窗口的 active conversation id；
- 输入草稿、焦点、tab、search 文本；
- 当前选择的 Run/Artifact 与结果 workspace 开关；
- 短生命周期 preview Blob URL 和本地 loading/error presentation；
- dialog/drawer/fullscreen 的交互状态。

UI 不拥有 messages、streaming、queue、tool execution、Character、Display、Run 或 Artifact。它可以对权威值进行响应式分组和展示计算。

## 启动与查询

1. bootstrap 读取安装级信息和 system onboarding 状态；
2. 读取当前角色及 character onboarding；
3. 获取轻量 conversation list；
4. 选择窗口 active 后显式 open/get 单个 conversation；
5. 读取该 conversation 的 Character/Display detail；
6. 订阅 durable invalidation 与 Pi transient stream。

客户端绝不在 bootstrap 中遍历每个会话。detail 按 active/需要展示的资源读取，event gap 或重连时用 detail/snapshot 替换本地 projection。

## 多 Session 与流式显示

每个 Pi event 带 session id。store 为相应 conversation 更新 token 文本、tool activity、queue、error 和 settled projection；窗口切到另一个 conversation 时，后台的原 Session 继续运行和接收事件。

发送、abort、edit、retry、navigate、continue 与模型选择都传明确 conversation id。按钮 disabled 和 spinner 来自目标 Session 的 Pi native live state，不能引入另一个发送中业务标志。

## 双层 onboarding

System Onboarding/Settings 负责 provider、credential、configured model pool、系统默认模型、网络、embedding 与本地模型下载。

Character Onboarding 只展示角色第一次见面、关系选项、自动记忆 consent、角色包首次选择，以及从系统模型池选择的角色默认 route。缺少系统能力时，角色流程暂时打开 System Settings；完成后继续角色流程，已存在角色不会重做系统设置。

## Character / Display 投影

角色 store 只订阅当前 conversation 的统一 Character/Display snapshot。场景、表情、媒体、choice 和其他 presentation 都由这条路径派生。choice click 仍然是普通用户输入，走与手写文本相同的 send path；没有专属命令协议。

Run、Artifact、permission 和 Pi live state 从各自来源读取，不拼入 Character/Display。

## Current work 与结果 workspace

External Run 的进度和 needs-user 状态展示在会话时间线/当前工作面。Run 完成时只提示，不自动打开结果。

用户选择完成 Run 或 Artifact 后，UI 以 `{conversationId, runId, artifactId}` 打开结果 workspace：

| 宽度 | 组件行为 |
| --- | --- |
| `>= 1600px` | conversation 与 result preview 双列 |
| `768..1599px` | right-side overlay/drawer |
| `<= 767px` | full-screen result view |

选择不属于 active conversation 的结果会先关闭旧选择。关闭 workspace 恢复普通会话布局。

## Artifact 预览与动作

metadata、provenance/evidence 和 corruption/unavailable error 都来自 Host。安全 text/image/PDF/audio/video 预览通过有界 chunk 组合 Blob URL；切换或关闭时立即 revoke。

open、reveal、Save As 调用 ID-only RPC。Desktop 交给原生 presenter；WebDev 提供浏览器安全 preview/download，unsupported native 动作应明确呈现，而不能猜测 CAS URL。

## 响应式与可访问性

- 主 UI 必须在上述三个 breakpoint 验证，不以桌面最小宽度掩盖布局问题。
- 对话是 live region；tool/run/artifact rows 有稳定语义与键盘入口。
- drawer/dialog/fullscreen 管理焦点回收、Escape 与可访问名称。
- 媒体使用真实 MIME 和可用 captions；文本以 DOM text 呈现，不注入 HTML。
- 产品文案来自 `@bear-harness/i18n`；角色文案来自验证后的角色包。

## 验证

```sh
npm run typecheck --workspace @bear-harness/companion-ui
npm run test:unit --workspace @bear-harness/companion-ui
npm run test:coverage --workspace @bear-harness/companion-ui
npm run test:e2e:web:required
```

人工验收还要真实点击系统设置、角色 onboarding、并发两个 Session、流式切换、后台 Run 完成、Artifact preview/download、三个结果 breakpoint 以及 rename/archive/delete/restart recovery。
