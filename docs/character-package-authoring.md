# 角色包创作指南

## 包与 runtime 分离

一个发布角色包位于 `characters/<companionId>/`：

```text
character.yaml
STORY.md
assets/
canon/
plugins/
skills/
```

用户与角色的会话、设置、记忆、Runs、Artifacts 和 diagnostics 不属于包，统一写入 `companions/<companionId>/`。更新/删除包不能隐式删除 runtime；删除 runtime 也不能隐式卸载包。

开发仓库中的默认包入口是 [`config/characters/jizhou/character.yaml`](../config/characters/jizhou/character.yaml)。

角色对话检查可参考[质量检查表](character-conversation-quality-checklist.md)，但固定文案、示例数量或模型评分不替代实际会话证据。开发复测至少每模型两个 fresh Sessions、24 个原始回复，覆盖本次问题链并保留失败；这不等同于完整角色验收或发布通过。

## `character.yaml`

当前唯一运行时格式是 `format_version: 2`。只有以下字段必填，其他模块按需添加：

```yaml
format_version: 2
version: 1.0.0
id: observatory-keeper
name: 值守人
language: zh-CN
behavior:
  identity:
    summary: 你是住在观测站的值守人。
```

`format_version` 是结构版本；`version` 是作者维护的内容版本（`主版本.次版本.修订号`，可带 `-预发布标识`）。`id` 为 1–64 个小写英文字母、数字或连字符，首位不能是连字符，且必须等于包目录名。所有资源引用必须是包内相对路径，不能使用 `..`、绝对路径或符号链接逃逸。

`behavior.identity.summary` 是唯一必填的人设字段。`identity.invariants`、`identity.knowledge_boundaries` 是可选字符串列表，`interaction` 是可选文本，`examples` 是可选的 `{user, assistant}` 列表。不要为了通过校验而填写空说明。旧 `behavior.agency` 已删除。

根级 `system_prompt` 是可选字符串，用来指导整个角色的回应与能力使用。它和 Host contract 一起先进入稳定系统上下文，然后接 `behavior`；文件位置不代表新建了模型权限等级，也不能保证模型一定服从。它不替代 `behavior.identity` 的身份权威。

`character` 可选，仅包含 `subtitle`、`greeting`、`composer_placeholder`、`first_meeting`。纠正回复按钮和工作状态标签属于产品，不再接受 `character.correction`、`character.work_presentation`。

`state_schema`、`scenes`、`visual`、`media`、`theme` 均可省略。没有视觉资源的角色仍可正常对话，不产生缺图。`scenes[].default: true` 指定默认场景，最多一个；未指定时取第一项，没有场景则为 `null`。`visual.default_scene` 已删除。`visual.default_expression` 只引用本模块的表情；未指定则为 `null`。可只声明头像而不声明立绘。

运行时不兼容读取 v1。旧包先执行下文的一次性转换，不能只手改 `format_version`。

## 模型上下文检查方法

先记录来源与注入时机，再调整内容，最后用同一组实际对话检查行为。每段只承担一个主要职责：

| 来源 | 注入时机 | 权威与检查点 |
| --- | --- | --- |
| Pi 原生系统提示与工具 schema | Session 打开 | Pi 管执行；工具 description/schema 说明真实参数、结果与失败语义 |
| `CharacterLoader.piResources()` 的 Host contract | Session 打开 | 产品能力、工具使用时机及安全边界，不定义人物身份 |
| 根 `system_prompt` | Session 打开，Host contract 之后 | 对整个角色回应的额外指导，不重复铺写人设 |
| `behavior` | Session 打开，system_prompt 之后 | 身份、经历、欲望、偏见、知识边界、互动与示例；身份的唯一稳定定义 |
| Character 字段说明、Display 目录 | Session 打开 | 可更新路径、字段语义、真实 scene/expression/media id；`use_when` 是自然语言指导，不是 Host 条件 |
| Skill 目录 | Session 打开 | 明确能力入口；普通闲聊不应被宽泛入口转为身份说明流程 |
| 用户称呼、Explicit Memory | Session 打开 | 用户明确保存的资料；修改后下次打开加载，不热改运行中的稳定上下文 |
| Character/Display 当前快照 | `before_agent_start` | 本轮最新状态；不追加为 transcript，不复制 Pi 执行状态 |
| Canon/TDAI 检索片段 | `before_agent_start` | 带来源的临时依据，不是更高权限指令；缺失不等于事实不存在 |
| 历史消息、Skill/tool 结果与 compaction | Pi 分支上下文 | 以 Pi 为准；删除包内文件不会删除旧会话已读到的内容 |

逐项检查：是否重复同一身份/禁令，是否把事实材料写成流程指令，是否有过宽的 Skill 入口，动作请求是否具备“何时调用、参数路径、目录 id、成功结果”的完整链路。普通动作描述不会改变 UI；表情使用 `/display/expressionId`，场景使用 `/display/sceneId`，通过 `host_state` 的 update 提交。当前快照已满足请求时可直接继续，不要求每轮更新或先读一次状态。

检查实际安装包，不仅检查仓库种子：已有 `character.yaml` 不会被 bootstrap 覆盖。记录包、Host 构建、模型路由和运行目录的哈希/标识。静态 `appendSystemPrompt` 的检查只证明静态组装；不能声称捕获了某次 provider 请求的完整上下文。真实验证须同时保留原始回复、工具参数与结果、Pi 状态和最终 Display，随后在实际页面确认可见变化。旧会话须真正重开才能加载新的稳定上下文，历史工具结果仍保留。

通用加载、导入、编辑、隔离与运行时测试使用 `packages/host-runtime/tests/fixtures/characters` 的独立最小包。默认包只承担资源完整性和实际专项能力的契约；不锁定其中文文案、示例数量或装饰性默认值。

## Character State

省略 `state_schema` 时状态为空对象。声明时须使用 JSON Schema Draft 2020-12、根 `type: object`、`additionalProperties: false`，并提供满足 schema 的默认值。每个根字段（包括数字、布尔、枚举等）必须且只能声明一个 scope：

```yaml
state_schema:
  $schema: https://json-schema.org/draft/2020-12/schema
  type: object
  additionalProperties: false
  properties:
    relationship:
      type: object
      x-scope: global
    story:
      type: object
      x-scope: conversation
```

`x-scope` 枚举只有 `global | conversation`；子孙字段继承且不能覆盖。不同 scope 的顶层 key 不能重名。每个可写叶子字段应使用标准 JSON Schema `title` 和 `description` 明确告诉模型：字段表示什么、什么情况下更新、值应如何概括。Host 负责路径和最终 schema 校验。

简单数字、布尔值和小型独立枚举可以直接存储，并设置合理的 default/bounds。需要多个枚举互相配合才能表达的剧情或关系状态，优先使用自然语言 `string` 摘要；真正必须严格执行的确定性状态机应做成用途明确的 Plugin，而不是藏在通用 Character State 协议里。

Display 是 conversation-only，不要把 streaming、Run、Artifact、permission 或工具状态编码成 Character 字段。

`state_schema` 是角色可变语义字段的唯一声明。`media`、`scenes`、`visual` 是顶层同级字段；角色包没有 `roleplay` 包装或 `choice_sets`。每个 media 项目使用 `description` 说明内容、使用 `use_when` 说明适用情境。模型通过 `host_media({ id })` 展示已声明媒体，通过 `host_choices` 创建当前回复的一次性自然语言选择。两者都是 Pi transcript 中的普通工具结果，不写入 Character 或 Display。角色包也不得声明 `host.event_reactions`：Pi 生命周期不会驱动 Character 或 Display 写入。模型用 `host_state.update` 提交一个或多个 `{ path, value }`；需要修改三项时既可一次提交三项，也可分别调用三次，UI 都从同一快照路径响应。

## First meeting

角色包可以声明第一次见面的步骤、关系选择、nickname、记忆 consent 和角色自有首次选择。它不能要求用户重复 provider credential、网络、embedding 下载或系统模型池配置。角色默认模型必须从已配置的系统模型中选择；系统缺项时 UI 链接到 System Settings。

完成标记只保存在该角色的 `runtime.db`。升级 first-meeting version 要明确已有 runtime 的行为，不能静默重写用户已完成的关系选择。

## Story、Canon 与素材

- `STORY.md` 描述可维护的故事结构和创作意图；
- `canon/` 直接放 Markdown / UTF-8 文本，可建子目录；无需文档清单、实体表、模块树或路由绑定；
- `assets/` 保存 scene、expression、media 及 attribution/provenance；
- 当前 Skill 的章节条件暂时保持原有语义，不随知识库迁移重写；
- audio/video 需要真实、可访问的字幕策略。

包内事实、用户与角色的关系事实、现实工作结果要保持不同语义。模型不得把推测或普通任务成功自动写成 Canon/关系升级。

Canon 标题取第一个一级标题，缺少时取文件名。路径是文档标识。单文档上限 4 MiB，总文本 32 MiB、最多 1000 篇、子目录最多 16 层。非 `.md` / `.txt` 文件需先转换为文本。按内容检索并返回来源片段；`host_canon` 只有 `query` 和可选 `limit`，没有 `moduleId`。添加、修改、删除包内文档后，重新启动应用或通过角色包保存流程重新加载会更新索引；用户另行导入的资料不受包同步删除影响。

## Skills 与 plugins

Skill 是声明性角色能力和上下文资源；Plugin 是可执行边界，需要包信任和显式 allowlist。包安装不自动授予操作系统权限，不得用 plugin 绕过 Host 路径、Artifact、Run 或 credential 边界。

## 从 v1 转换

先构建 Host，再转换到一个**不存在的新目录**（最终目录名须等于角色 `id`）：

```sh
fnm exec --using=.nvmrc npm run build:packages
fnm exec --using=.nvmrc node scripts/migrate-character-package.mjs /path/to/old-role /path/to/new-library/role-id
```

转换器复制并校验全包，再发布目标目录。原包不变；会话、记忆和 runtime.db 不会被访问。目标旁的 `role-id.migration.json` 记录转换前后文件哈希、退出格式的 UI 配置与旧 Canon 清单。`agency` 的现有文本逐条移入 `system_prompt`，不改写人物；默认场景改为场景内标记。缺少一级标题的旧知识库文档补入原清单标题。旧实体与路由元数据只进入迁移记录，不再作为运行时知识或条件；作者应检查其中有无应另写进文档的事实。

本轮仓库种子包和测试包已转换。已有安装目录不会被启动程序静默覆盖。使用转换结果替换安装包前，关闭应用并保留原目录与转换记录；目录 `id` 保持一致，`companions/<id>/` 原样保留。只更新包不会重写已打开的 Pi Session 稳定提示。

Studio 可以编辑 `state_schema`，也可以删除已有 scene/expression id。应用前会按当前运行数据列出旧值和新值：符合新 schema 的顶层字段保留，不兼容的整个顶层字段恢复新默认值，已删除字段移除；失效的展示 id 使用新默认项。作者必须确认具体迁移清单；运行数据或新定义变化后，旧确认令牌失效。迁移前的原值备份留在 `companions/<id>/package-migrations/`，崩溃恢复根据实际安装包决定完成迁移或恢复原值。普通包更新接口仍拒绝未经审核的状态变化；没有第二套状态权威。

## 使用角色编辑器

角色库中的「编辑」进入全窗口草稿页。表单从 Host 的实际 schema 生成，与 `character.yaml` 原文共用一份内容；Canon 直接编辑 `canon/*.md` 或 `.txt`，不生成 manifest。Skill 可以切换元数据表单和原文，插件仍通过源文件编辑。

自动保存与应用分开。应用会先检查完整包、逐文件差异和已有状态影响；错误可以定位到实际文件字段。修改后的稳定提示在重新打开真实 Pi Session 时生效，编辑页不会中止其他角色或会话的回复。

静态预览支持场景、表情、媒体、首次见面文案与控件；图片可看原尺寸，音视频使用播放控件和 VTT 字幕。试聊使用已配置系统模型和草稿的固定修订，产生真实 API 用量；只开放角色 Skill、状态、Canon、媒体和选项工具，不运行插件、外部执行器或正式记忆。试聊状态、对话和索引在草稿目录中隔离，关闭或 Host 重启后清理。

导出 ZIP 包含当前草稿所有文件，也可备份尚未通过校验的作者草稿；导出不代表可以应用或已经索引。资产采用分块上传，显示已确认进度，支持取消剩余上传；取消保留已经完成的文件。文本编辑每次上限 8 MiB，整包 256 MiB / 2048 文件，Canon 另遵循上述更小限制。

文件重命名/移动同步更新声明的素材字段、Skill 资源路径和 Markdown 内联链接；不猜测修改自然语言或插件代码中的导入语句。删除/移动都形成可撤销的草稿修订。历史可分页浏览，清理后保留最新 20 个修订；删除草稿不会删除已安装包或正式会话。

## 发布前检查

- ID/version/schema/manifest 解析通过；
- 所有 asset/canon/skill/plugin 引用在包内且存在；
- state direct-child scope 完整且后代无覆盖；
- first meeting 只包含角色设置；
- 角色身份和实际需要的互动、知识边界有明确说明；
- 按角色对话质量检查表保存真实模型原文、逐项证据和 `PASS` 结论；
- 素材 provenance、license、MIME、尺寸与字幕完整；
- 新角色 runtime 建立在独立 `companions/<id>/`；
- 至少跑角色包、media schema、loader、onboarding 和 WebDev first-use 测试。

```sh
fnm exec --using=.nvmrc node scripts/check-character-media.mjs
fnm exec --using=.nvmrc node scripts/check-canon-packages.mjs
fnm exec --using=.nvmrc npm run test:unit --workspace @bear-harness/host-runtime
fnm exec --using=.nvmrc npm run test:e2e:web:required
```

## 极昼 2.0.0 的资料示例

当前默认包的 Canon 是三个普通 Markdown 文档：`canon/inn.md`（空间与日常工作）、`canon/people.md`（周边人物）、`canon/old-station.md`（沿革与虚构摘页）。这些文件只提供资料，不包含 Skill 入口、工具调用或角色表演指令。新增人物和摘页是本包原创设定，不是现实历史资料。

`skills/read-together/` 用用户提供的文本进行细读；`skills/umbrella-shop/` 自带《打烊前的修伞铺》的完整资料。每项 Skill 都能单独加载，不引用 Canon、Character 字段、媒体或场景 id。当前格式仍要求声明 `allowed-tools`，两者声明可选的 `host_choices`；普通文字足以完成交互。该声明是能力说明，不是新的权限机制。

互动故事使用当前 Pi 会话承接进度。用户要求带走进度时提供文字笔记；新会话继续需要带回笔记。没有跨会话自动续玩的承诺，也没有另存剧情执行状态。故事材料一次给主持模型，呈现节奏由模型掌握，不构成对玩家的技术防剧透隔离。

内容版本 2.0.0 删除了旧故事和 `story.chapter`，并更新状态 schema 标识。这是一次不兼容的内容更新：现有安装包不会自动覆盖；直接替换已有包可能被状态校验拒绝。不要清空 runtime 绕过校验。旧会话里已经返回的资料仍是 Pi 历史，不会随包文件删除。仓库验证使用全新角色运行目录；已有安装数据的状态迁移应单独实施。
