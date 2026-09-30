# 模块化、独立 Android 与 Character Studio 联合方案

> 格式校正：本稿涉及角色包字段、命名和必需文件的描述存在偏差，不可作为格式实现依据。以当前源码及 [格式校正记录](character-studio-format-correction-2026-09-29.md) 为准；此前原型通过的流程检查不证明包格式正确。

日期：2026-09-24。代码基线：`3dfc847`。状态：调研与实施建议，尚未实施、尚未通过 Android 真机验证。

已确认目标：先模块化，再 Android；Android 手机独立使用、直连模型 API，裁掉桌面执行能力。角色包编辑支持已有角色、新建角色，以及完整包内容。

## 1. 决策建议

1. 第一阶段交付可裁剪的 Host、独立全窗口 Character Hub / Character Studio，以及桌面环境下可运行的精简配置。
2. 第二阶段新增 `apps/mobile`，优先验证 Capacitor + Android 原生桥 + 内嵌 Node + 真实 Pi AgentSession。Pi 仍唯一拥有对话和执行状态。
3. Android 首版保留对话、角色呈现、角色包创作、显式记忆和包内知识；移除外部执行器、任意代码插件执行、本地大模型与桌面文件系统工具。
4. 内嵌运行时是可行性门槛，不能把“能打出空壳 APK”当作 Bear 已完成移植。门槛不通过时重新评估 Pi 的可移植性，不在 Bear 内实现另一套会话状态机。

## 2. 当前代码事实

| 位置 | 已有能力 / 缺口 | 对方案的影响 |
| --- | --- | --- |
| `packages/companion-client/src/client.ts:18` | `HostTransport` 已抽象请求、失效通知与原生实时事件 | 可新增 Android bridge transport，复用协议和客户端 |
| `packages/companion-ui/src/App.tsx:52` | SolidJS 共享应用；仍以 DesktopFrame 与角色运行上下文组织 | 保留组件，拆出应用导航、对话页和作者工作区 |
| `packages/host-runtime/src/character-runtime.ts:284` | 直接装配 Pi Worker、Codex、自定义 ACP 与 Run service | 不隐藏按钮了事，要拆开依赖与装配入口 |
| `packages/host-runtime/src/companion/host-tool-register.ts:25` | 工具输入强制依赖 delegate / Run；顶层导入 OfficeParser | 分离核心角色工具、执行工具、文档工具 |
| `packages/host-runtime/src/companion/pi-runtime.ts:992` | 使用真实 `createAgentSession`；依赖 Node 文件系统和 Pi 资源加载器 | WebView 本身不足以承载当前会话运行时 |
| `packages/host-runtime/src/storage/database.ts:9` | `node:sqlite`、Drizzle node-sqlite、sqlite-vec | 内嵌 Node 版本和原生扩展要单独验证；普通数据库不应强制加载向量扩展 |
| `packages/companion-ui/src/features/Backstage.tsx:22` | 当前角色管理在右侧 Dialog 抽屉 | 作者工作区应提升到应用顶级页面 |
| `packages/companion-ui/src/features/CurrentRolePackageManager.tsx:33` | 编辑 behavior 的部分字段、examples 和 system_prompt | 尚非完整包编辑器 |
| `packages/host-runtime/src/companion/character-loader.ts:1056` | packageGet / update 面向 character.yaml，已有 SHA 冲突检测和目录替换 | 复用校验与安全写入，升级为全包 revision |
| `packages/host-runtime/src/companion/character-draft-service.ts:16` | basePackageId 仅保存元数据，初始 files 是空对象 | 编辑已有包必须实现完整快照初始化 |
| 同上 `applyPatch` / `uploadAssets` / `publish` | patch 只合并文件；专用素材接口只接受图片；publish 调用 install，已有 ID 会冲突 | 补删除、重命名、音视频与已有包更新；统一写入机制 |
| `packages/host-runtime/src/runtime.ts:173` | 作者草稿目前存在 systemDb | 角色内容草稿应转入角色所属 runtime 空间，系统库仅保留安装级注册信息 |

当前架构是“前端已经部分共享、后端仍捆绑桌面能力”。重构重点在模块所有权、依赖图、装配与持久化，不能用拆小文件代替。

## 3. 第一阶段：模块化

建议建立以下模块边界。包名是建议；小模块可先作为有清晰 export 边界的目录，避免一开始过度拆包。

| 模块 | 拥有内容 | 不应依赖 |
| --- | --- | --- |
| `character-package` | manifest / Story / Canon / Skill 的数据契约、解析、引用关系、纯校验、平台兼容报告 | Electron、Pi Session、执行器、数据库 |
| `character-authoring` | 草稿、版本、文件操作、素材、diff、整包校验、安装与更新事务 | 对话 UI、默认角色选择、External Runs |
| `host-runtime` 核心 | 安装/角色资源管理、Session Catalog、真实 Pi Registry、Character/Display、两层 onboarding | 具体桌面执行器、Electron UI |
| `execution-runtime` | ACP adapters、Run 生命周期/恢复、执行权限、Artifact capture 与 Run 结果交付 | 编辑器状态、全局活动会话 |
| memory adapters | 显式记忆、TDAI、远程 embedding、本地 embedding 与向量存储分别装配 | 以普通数据库初始化强制启动所有记忆后端 |
| platform adapters | credential vault、文件导入导出、媒体 URL、原生生命周期、系统分享/打开 | 角色身份和会话语义 |
| `character-studio` | Hub、编辑器、预览、文件导航、修改摘要 | Electron globals、真实文件路径、必须已打开的聊天 |

依赖方向：应用入口选择模块 → 模块注册 RPC / 工具 / 能力 → UI 消费协议。核心不得反向导入可选桌面模块。

### 3.1 两种明确的装配配置

- Desktop full：保留现有执行、Artifact、自动记忆与原生桌面能力。
- Companion minimal：保留核心角色对话与创作能力；不装配执行模块和不支持的本地原生依赖。

先在现有桌面/WebDev 测试环境运行 minimal，证明核心无需外部执行器也能工作，再迁 Android。

能力由实际装配生成，不靠 Renderer 猜 `platform === android`。至少区分角色创作、插件执行、External Runs、附件读取、本地/远程记忆、文件导出等能力。不可用的执行工具不进入模型工具表，不进入 Host 的能力说明，不触发 UI 后台查询；越界调用在 Host 明确拒绝。

导入的角色包保持完整；“可保存编辑”与“可在当前设备执行”分开。依赖缺失工具的 Skill 不向模型宣称可用。已有角色文字中若硬编码了桌面执行流程，兼容性检查提示作者修改，不能假装自动理解并正确改写所有自然语言指令。

### 3.2 包含在这一阶段的工程门槛

- minimal 的运行依赖和产物中没有 Codex/ACP 子进程启动器、桌面 shell 集成、本地 llama。
- 核心不静态导入 OfficeParser / sqlite-vec 等已裁能力；不使用空实现伪装成功。
- Pi 保持消息、分支、模型、队列和运行状态的唯一权威；选页和打开编辑器不改变 Pi 生命周期。
- full 与 minimal 均通过双 Session 并发、切换时流式输出、角色路径隔离、两层 onboarding 回归。
- 拆 RPC composition 为系统、角色、会话、创作、执行、诊断等注册入口；合同测试按实际装配验证。
- 接口替换要更新调用方与测试，不保留旧包编辑模型的双写或兼容别名。

## 4. Character Hub 与全窗口 Character Studio

2026-09-29 补充：具体页面、字段、按钮、异常和验收以 [完整交互规格](character-studio-interaction-spec-2026-09-29.md) 为准。编辑器默认只保留导航与编辑两栏，预览按需打开。

### 4.1 页面与导航

建议是同一应用窗口内的独立页面，占满内容区，不要求操作系统全屏，也不默认新开窗口。

应用顶级页面：对话 / Character Hub / Character Studio / 系统设置。

- Hub：角色卡片、搜索、新建、导入、编辑、复制为新角色、导出、草稿恢复、兼容性提示。
- Studio：打开时替换聊天与立绘区域；应用级 transport、Pi 订阅和资源管理保持存活。
- 顶部：返回、角色名、草稿保存状态、校验、预览、应用到角色、导出。
- 左侧：内容分类与文件树；中间：编辑；右侧：可收起的预览/引用/问题面板。
- 手机：单栏，目录作为抽屉，编辑/预览/问题切换；Android 返回键优先处理当前编辑导航与未落盘内容。

Hub 可以在没有可聊天角色、没有完成模型配置时用于创作。不能必须先创建或选中真实聊天 Session 才能进入编辑器。

### 4.2 全包覆盖范围

| 分类 | 可编辑内容 | 编辑方式 |
| --- | --- | --- |
| 基础信息 | id（新角色）、名称、语言、角色卡片、主题 | 专用表单 |
| 人设与行为 | 完整 behavior、identity、agency、interaction、examples、system_prompt | 长文本、列表、示例表单；身份保留单一权威 |
| 首次见面 | greeting / first_meeting、角色自有选择与 consent 相关配置 | 步骤表单与流程预览，仅包含角色层设置 |
| 视觉与场景 | avatar、expressions、scenes、默认场景/表情、theme | 素材选择、排序、预览、引用检查 |
| 媒体 | 图片/音频/视频、description、use_when、字幕与来源元数据 | 上传、替换、预览、元数据表单 |
| Character State | state_schema、scope、default、title / description、约束 | 类型表单 + JSON Schema 原文 |
| Story | STORY.md 以及包内相关创作文本 | Markdown 编辑与预览 |
| Canon | 文档标题、正文、人物与专题 | 新建/导入/编辑/删除；系统自动维护目录与引用，不要求编辑 manifest |
| Skills | SKILL.md、元数据、资源 Markdown | 结构化元数据 + 正文编辑；显示缺失工具 |
| Plugins | 源文件、附带资源 | 源码编辑；Android 可以保存/导出，首版不执行 |
| 全部包文件 | 新增、改名、移动、删除、二进制替换、来源/许可文件 | 高级文件工作区；受包根目录约束 |

完整覆盖依靠“常用内容表单 + 全包文件编辑”，不必把每种源码都做成复杂表单。Schema 内的新字段可通过通用编辑和原文编辑覆盖；未知/不支持的格式需明确报错，不能静默删除字段或引入旧格式兼容。

表单和 YAML / Markdown 编辑共享同一份草稿文件模型。使用 YAML AST 定点修改，保留未触及内容；原文暂时不合法时保留原文，暂停依赖解析的表单，不用旧表单值覆盖它。

编辑包中的 state_schema、默认值，与修改用户当前 Character/Display、MEMORY.md、运行时 Canon 数据是不同操作。后者留在角色数据/记忆管理页；普通角色 ZIP 不包含会话、用户记忆、模型密钥和自动记忆索引。

### 4.3 新建、编辑和保存统一流程

`新建 / 从已有包编辑 / 复制 / ZIP 导入 → 草稿 → 自动保存 → 校验与 diff → 应用 / 导出`

- 新建：生成合法最小模板，覆盖 loader 的必需文件、默认视觉引用与 Canon manifest；不能只建空 YAML。
- 编辑：从完整已安装包创建快照，记录基线包 hash 和文件 hash。
- 复制：分配新 id，复制包内容，不复制会话、记忆、信任或 onboarding 完成状态。
- 草稿保存：允许未完成、引用缺失或语法尚不合法的文本；不会影响当前角色。
- 应用：对确定 revision 做全包校验，再以目标包基线进行冲突检测和原子替换。
- 导出：默认要求可安装的有效包；未完成内容如需导出，应单独标记为作者草稿。

作者草稿按角色隔离，拟放在 `companions/<id>/authoring/`，元数据在该角色 runtime.db。新建时先分配作者身份，不等于完成角色 onboarding。此目录扩展与草稿存储迁移需写入架构约定；删除角色 runtime 必须说明会清理其未发布草稿。

不要为每次键入将整包音视频 base64 写一遍数据库。小文本做有界版本保存，二进制按文件 hash 在该作者工作区内管理；分块上传，用不透明资产 id 引用。作者素材不是 Run-owned Artifact，不进入 Artifact CAS。

建议的服务操作：create/read/list draft、list/read file、apply file operations、asset upload、diff、validate、commit、export、restore revision、delete draft。文件操作明确含 create/write/move/delete，带 expectedRevision。Host 校验逻辑相对路径；Renderer 不提供权威物理路径。大文件走有界传输，不能把全包塞进 bootstrap。

所有安装入口使用同一个包校验器和提交路径；编辑已有包使用 replace，安装新角色使用 create。替换旧 YAML-only 写入口，不维持两套写入权威。并发冲突范围涵盖 STORY / Canon / Skill / 媒体，而不仅是 character.yaml。

### 4.4 校验和生效语义

- 校验层次：语法 → schema → 文件/引用 → MIME/大小/路径 → 当前设备能力 → 现有 runtime 数据兼容性。
- 删除被引用素材时列出使用位置；原子更新所有显式引用，或阻止应用直至作者修复。
- 修改/删除有历史数据的 state 字段不能默默清空数据。首版阻止不兼容替换，提供复制为新角色；复杂数据迁移另行设计明确规则。
- first_meeting 改动不重置已完成 onboarding。id 在原地编辑时不可变；更换身份走复制。
- 插件变化使原信任失效，按新内容 hash 重新确认；预览、校验不能执行插件。
- 角色有运行中的 Session 时，可以继续保存草稿；首版明确阻止“应用”，提示结束当前生成后重试，不隐式 abort，也不创建后台等待提交状态机。
- 应用时对目标角色短暂建立资源变更排他，重新检查运行状态和 package hash；提交成功后关闭该角色的旧 idle handles，使下次打开重新加载稳定上下文。其他角色不受影响。
- 静态预览不用真实 Session。试聊使用隔离的临时角色 runtime 和真实 Pi Session，不读写生产角色记忆，结束后按资源生命周期清理。

## 5. 第二阶段：独立 Android

### 5.1 候选路线

| 路线 | 本仓库适配程度 | 判断 |
| --- | --- | --- |
| Capacitor + 内嵌 Node + 精简 Host/Pi | 最大程度保留 Solid UI、Pi、包格式和 Node 文件语义 | 首选验证方向；有原生运行时维护风险 |
| WebView + 浏览器内聊天运行时 | UI 可复用，但当前 AgentSession / SessionManager / 文件资源加载不能直接搬入 | 当前不选；若推进必须先在 Pi 层建立真正支持的可移植会话能力 |
| React Native / Flutter / Kotlin 重写 UI | 大量现有界面和编辑器需重建；本身不解决 Pi 的 Node 依赖 | 首版不选 |

建议结构：`Solid UI / Studio → HostTransport Android bridge → Kotlin/JNI → embedded Node → minimal Host → Pi AgentSession → provider HTTPS API`。

模型请求由本地运行时发出，密钥通过原生 vault 获取。原生桥只暴露有 schema 的 RPC、流式事件和有界资源操作；不暴露任意路径或执行能力，不把 token 流写成第二份 transcript。优先进程内桥，不把 WebDev 的调试 HTTP 服务直接打包成生产服务。

### 5.2 首版功能取舍

| 功能 | Android 首版建议 |
| --- | --- |
| API key 模型、流式回复、切换/多会话、Pi 分支/重试/中止 | 保留，以真实 Pi 为准；未测试的 provider 单独列兼容状态 |
| 角色呈现、场景、media、choices、Character/Display | 保留 |
| 全窗口 Hub / Studio、ZIP 导入导出、完整包创作 | 保留；手机界面单栏化 |
| 显式记忆、声明式 Skill、包内 Canon | 保留；文件读取限定角色资源边界 |
| 自动 TDAI / 远程 embedding | 后续增量：API 是远程的不等于本地索引没有 native 依赖；首版须明确显示不可用 |
| 本地 embedding / llama / 模型下载 | 首版移除 |
| Pi Worker、Codex、自定义 ACP、shell、任意工作目录读写 | 移除，不注册相关模型工具与 RPC handler |
| 可执行角色插件 | 保留编辑与导出，禁止加载执行 |
| External Runs / Run-owned Artifacts | 首版移除；角色素材和导入文件保持独立类型 |
| Office 文档解析与任意本地文件搜索 | 首版移除；用户选图、包内文档可作为独立受控能力 |
| 桌面 OAuth 流程、系统代理探测、桌面更新器、reveal | 不照搬；首版 API key，其他逐项做原生适配 |

桌面版保留 full 功能。若后续用户要求全平台砍执行，可直接停止装配 execution 模块，不重写核心。

### 5.3 首个技术验证必须回答的问题

当前 `.nvmrc` 是 Node 24.19.0，已安装 Pi 0.85.1 的最低 Node 版本是 22.19.0。经典 nodejs-mobile 仓库当前 release 页的 Latest 是 18.20.4，不能直接用于当前依赖。另有 fogtape 的 Node 24.18.0 构建方案，属于待审计候选，尚未验证其二进制、API 或与本仓库的兼容性。[nodejs-mobile releases](https://github.com/nodejs-mobile/nodejs-mobile/releases)、[Node 24 candidate](https://github.com/fogtape/nodejs-mobile/blob/recipe/README.md)

Node 官方仍将 Android 列为不支持的平台。因此需要锁定源码、补丁、NDK、ABI 和可复现产物，并承担更新责任。不能因为 ARM64 Linux 可用就认定 Android 可用。[Node build guidance](https://github.com/nodejs/node/blob/main/BUILDING.md#android)

PoC 通过条件：

1. arm64 真机启动匹配版本的 embedded Node，验证 ESM、crypto、TLS、fetch/流式请求、文件锁、fsync、atomic rename、node:sqlite WAL/FTS。
2. 加载真实 Pi AgentSession；不触发 TUI、终端、git、shell 或不支持的动态插件路径。审计间接依赖，不以“没点到”代替不可达。
3. 直连已配置模型，完整完成流式回复、host_state / media / choices 和显式记忆；确认中止、异常与重开语义。
4. 两个 Session 同时运行与切换，事件不串；恢复时由 Pi 快照替换 UI。
5. 进后台、锁屏、断网、进程被杀、重启和覆盖安装后，已有 transcript / 草稿可恢复，不制造假完成或自动重发用户消息。
6. 数据库和角色包崩溃恢复有效；基础对话不依赖 sqlite-vec/jieba/llama。向量记忆移植另设门槛。
7. 测量冷启动、内存、安装包体积、长对话滚动和手机输入；检查所有 native .so 的 16 KB page-size 兼容。

### 5.4 Android 平台工作

- 存储：原有 system / characters / companions 布局放在应用私有 dataRoot 内；用户通过系统文件选择器导入，复制到受管目录后校验，不把 content URI 当普通文件路径。
- 安全：密钥使用 Android Keystore 保护的 vault；JS UI 不保存密钥。媒体使用受控本地资源 URI；导入内容不成为 WebView 可执行网页或 JavaScript。
- 生命周期：Host 生命周期高于页面；Activity 重建不能重复启动 Host。首版承诺前台交互和可靠恢复，不能承诺永久后台生成。前台服务若后续需要，须按实际服务类型实现与验证。
- UI：软键盘、safe-area、返回手势、文本选中、触控、文件选择、媒体播放与分享；页面离开关闭媒体播放，但不以 UI 路由隐式终止会话。
- 分发：独立 Android 工程，固定 JDK/SDK/NDK/Gradle；构建 Web assets、同步 Capacitor、编译原生运行时、产出 debug APK，再产出 release-signed APK。需要商店分发时再产出 AAB。
- Android 安装要求 APK 签名；仓库关于桌面可不做 OS 签名的规则不能套用于 APK。GPG 发布校验可继续保留，但不替代 APK 签名。签名密钥和口令不进仓库。

上述平台约束来自 [Capacitor](https://capacitorjs.com/docs)、[Android background work](https://developer.android.com/develop/background-work/background-tasks)、[Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files)、[16 KB page sizes](https://developer.android.com/guide/practices/page-sizes)、[APK signing](https://developer.android.com/studio/publish/app-signing)。框架最低 Android 版本不能直接当产品最低版本，须结合依赖和真机测试决定。

## 6. 实施顺序与验收

| 阶段 | 工作单元 | 完成标准 |
| --- | --- | --- |
| 1A | 包契约/纯校验抽取，Host 工具与 composition 解耦 | 核心无反向桌面依赖；包读写行为回归通过 |
| 1B | full / minimal 装配、工具/协议/UI 能力一致化 | 桌面/WebDev 下 minimal 可真实对话；full 执行与 Artifact 回归通过 |
| 1C | 作者工作区、文件与素材 API、已有包更新事务 | 新建、编辑、复制、删除文件、冲突、崩溃恢复和导入导出闭环 |
| 1D | 全窗口 Hub / Studio、静态预览、移动宽度布局 | 所有包内容可编辑，跨字段/跨文件数据不丢；进入编辑页不中断聊天 |
| 2A | Android 原生运行时 PoC | 上述真实 Pi / SQLite / 流式 / 生命周期门槛通过，才承诺完整移植 |
| 2B | 移动壳、原生 vault / picker / resources / lifecycle | 两层 onboarding、对话、编辑、媒体、重启在真机闭环 |
| 2C | 发布流水线与真机回归 | 同一干净 commit 的签名 APK、校验文件、测试记录与明确风险说明 |

角色包编辑验收必须覆盖：完整既有包往返、不相关文件保持、空白模板、复制不复制用户数据、素材引用修复、二进制保真、并发修改、低磁盘/中断、插件 trust 失效、schema 不兼容阻止、运行中只能存草稿、离开编辑器与恢复草稿。

涉及角色提示、工具边界、Skill 或记忆上下文变化时，仍执行仓库 live-model 验证要求，不能拿静态 fixture 或手写示例代替。发布继续遵守现有适用 release gates，并新增 Android 真机、进程恢复、签名与 native ABI 检查。

## 7. 调研结论与限制

建议进入第一阶段；Android 进入有退出条件的可行性验证。全包编辑器方案可独立推进，并能复用于 Android。当前最大不确定性是 Node/Pi 的移动端运行与维护成本，其次是既有角色 runtime 与包更新的兼容性。

本次没有改业务实现、没有修改角色内容、没有调用真实模型或打 APK。代码观察与官方资料已核对；运行时兼容性、性能、包体积和工期尚无实测，不给“已经支持 Android”或发布通过的结论。
