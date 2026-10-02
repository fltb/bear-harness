# Character Studio 首批实现与验证

> 历史记录：下列“仍需推进”反映 10 月 1 日状态；10 月 2 日的完成项与剩余发布限制见 [后续实现记录](character-studio-implementation-2026-10-02.md)。

日期：2026-10-01。基线：`2ab4276`。结论：首批真实编辑流程可用于开发验证；完整 Studio 尚未验收，不发布版本或 APK。

此前的角色包 v2 迁移、Canon 向量检索与共享 embedding 已单独提交并推送到 `origin/main`。本批实现进入现有应用，不使用静态原型充当成品。包格式仍以源码、`docs/character-package-authoring.md` 和 v2 定义为准，不恢复 Canon manifest。

## 已实现

- Sidebar 的「角色库」和角色设置中的「编辑角色」进入独立全窗口页面。首次启动尚未设置模型时也可进入。角色设置继续管理模型、记忆、信任与删除。
- 角色库支持搜索、新建、复制为新角色、ZIP 导入、继续编辑和开始对话。编辑不会自动切换聊天角色。
- 基础表单分别编辑 `name`、`version`、`language`、`character.subtitle/greeting`、`behavior.identity.summary/invariants/knowledge_boundaries`、`behavior.interaction`、`system_prompt`。必填与选填明确标识，并展示真实字段路径。
- YAML AST 修改指定字段，保留其他模块与注释。YAML 语法或字段类型错误时引导原文修复，不用空表单覆盖原文。
- 完整包文件列表、文本编辑、新增与删除文本文件、上传/替换 `assets/` 文件、逐文件下载。复制与保存包含二进制文件，不再只保存 YAML、Story 和部分 Canon。
- 输入停止 800 ms 后保存草稿，支持显式保存、Ctrl/Cmd+S、离开前保存。正在保存时继续输入会串行保存下一修订，旧响应不覆盖新输入。
- 无效 YAML 也能保存。Host 重启后继续编辑；保存历史最近 100 条可恢复，恢复生成新修订。
- 保存失败保留本地输入，提供重试、下载当前未保存原文、明确放弃未保存输入。版本冲突不自动覆盖；已安装包变化时可从当前包创建新草稿，原草稿保留。
- 「应用到角色」校验完整包，展示目标、修订和文件数，再原子替换整包。活动请求、Pi streaming/compacting/retrying 或未结束 External Run 阻止应用。
- Studio 打开期间原聊天组件和订阅继续保留。浏览器验证了后台回复继续完成、返回后仍为原 Session，输入框草稿保留。

## 所有权与存储

```text
<dataRoot>/
  characters/<characterId>/        # 应用后生效的完整包
  companions/<characterId>/
    drafts/<characterId>~<uuid>/
      current.json                # 当前草稿元数据与文件 hash
      revision-<n>.json           # 修订快照
      <sha256>                   # 此草稿自己的文件内容
```

作者草稿属于角色目录。文件名、角色 id、路径、符号链接、内容 hash、单文件与整包体积均在 Host 检查。RPC 只接收包内相对路径，不接受 Renderer 指定的权威磁盘路径。元数据和文件分离，读取按 256 KiB 分块；单次写文件最多 8 MiB，整包最多 256 MiB / 2048 文件。已有大文件快照保留，但大于 8 MiB 的单文件暂不能通过编辑器更新。

`CharacterRuntimeRegistry.replaceIdle` 只在指定角色空闲时关闭其资源，并阻止替换过程中接入新请求。其他角色不关闭。Pi 继续拥有消息、执行与队列；Studio 保存的是作者内容，不复制 Pi 状态。更新包不会删会话、记忆或 onboarding。插件代码修改通过既有 hash 信任机制处理，本地应用不能继承官方来源自动信任。

草稿服务已不读写系统数据库中的旧 `character_drafts` / `character_draft_revisions`；这两个既有表仍在安装数据库 schema 中，尚未删除。没有双写或兼容读取。

## 验证

所有 Node/npm 命令均经 `fnm exec --using=.nvmrc`。

| 检查 | 结果 |
| --- | --- |
| 全仓 lint | 通过，包含 UI 设计、RPC、数据边界、测试质量检查 |
| 全仓 typecheck | 通过 |
| 全仓单测 | 1,253 通过，3 项既有跳过 |
| Host 单测（包含以上总数） | 678 通过，2 跳过 |
| UI 单测（包含以上总数） | 284 通过，1 跳过 |
| Electron + Web 生产构建 | 通过 |
| `character-studio.spec.ts` | 3 条浏览器旅程通过 |
| `layout-dom.spec.ts` | 1920×1080、1280×800、390×844 三档通过 |

Studio 浏览器旅程覆盖：新建、Canon 编辑、刷新恢复、无效 YAML 保存但拒绝应用、历史恢复、手机宽度应用；回复中禁止应用但不终止回复、返回保留输入与 Session；复制既有包、上传素材、下载字节一致、删除素材、草稿不提前进入已安装列表。测试使用隔离 dataRoot 和确定性 provider，没有改写用户实际角色包。

直接回归还覆盖了保存期间继续输入、失败后新输入保留、完整包 hash 冲突、重启恢复、不可变 id、路径和符号链接拒绝，以及替换角色时其他角色仍可访问。

开发截图：[桌面](evidence/character-studio-desktop-2026-10-01.png)、[手机](evidence/character-studio-mobile-2026-10-01.png)。截图是上述真实浏览器旅程，不是设计稿。

## 仍需推进

1. 高级专用表单：首次见面、成对示例、场景/表情/媒体、状态定义、Skill 元数据。目前可通过文件原文编辑，未做到全表单创作。
2. 静态预览、素材播放和独立试聊；完整 ZIP 导出；带引用检查的文件改名/移动；应用前逐文件差异和错误定位。
3. 现有角色状态 schema 变化、已有场景/表情 id 删除仍明确阻止应用，需要状态迁移设计。新角色可定义自己的 schema。
4. 草稿列表暂最多 200 条，缺少分页、删除与历史内容回收。多窗口通过同一 Host 的修订检查避免覆盖，不支持多 Host 同时写同一 dataRoot 的协作编辑。
5. 文件读取分块但每块仍重新读取并校验完整 blob，大包性能需优化；手机当前采用上下排列的文件导航和编辑区，未做 Android 真机/软键盘/系统返回键验证。
6. 未补覆盖率门槛、完整 required E2E、Electron E2E、恢复套件、安全签名、平台包和 packaged smoke；这次也没有做角色质量 live-model 发布验收。实际角色文本未改动，原有角色质量未通过发布门槛的结论保持不变。

## 变更规模与发布决定

相对 `2ab4276`，代码与测试涉及 6 个模块/目录、37 个文件，新增 2,430 行、删除 841 行（不计本报告、旧规格状态注记和截图）。拆分为 WebDev 2 文件、UI 20 文件、Host 9 文件、i18n 3 文件、protocol 2 文件、工程检查脚本 1 文件。

发布决定：作为 Studio 首批工程实现继续迭代，不宣称完整交互规格已完成，不发布安装包。
