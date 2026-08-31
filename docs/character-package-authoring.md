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

## `character.yaml`

最小包至少定义稳定的 ASCII kebab-case `id`、显示名称、semver、语言、角色文案、prompt/behavior 和可验证的 state schema。所有资源引用必须是包内相对路径，不能使用 `..`、绝对路径或 symlink 逃逸。

产品 UI 文案不要写进角色包；角色 greeting、first meeting、scene、expression、work presentation label 等角色语义文案应留在包中。

## Character State

state root 的每个 direct child 必须且只能声明一个 scope：

```yaml
state_schema:
  type: object
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
- `canon/manifest.yaml` 声明 Canon 文档、版本和引用；
- `assets/` 保存 scene、expression、media 及 attribution/provenance；
- unlock 条件由 Character State 推导，不创建独立收藏写模型；
- audio/video 需要真实、可访问的字幕策略。

包内事实、用户与角色的关系事实、现实工作结果要保持不同语义。模型不得把推测或普通任务成功自动写成 Canon/关系升级。

## Skills 与 plugins

Skill 是声明性角色能力和上下文资源；Plugin 是可执行边界，需要包信任和显式 allowlist。包安装不自动授予操作系统权限，不得用 plugin 绕过 Host 路径、Artifact、Run 或 credential 边界。

## 发布前检查

- ID/version/schema/manifest 解析通过；
- 所有 asset/canon/skill/plugin 引用在包内且存在；
- state direct-child scope 完整且后代无覆盖；
- first meeting 只包含角色设置；
- user agency、知识边界和失败表达有明确 behavior；
- 素材 provenance、license、MIME、尺寸与字幕完整；
- 新角色 runtime 建立在独立 `companions/<id>/`；
- 至少跑角色包、media schema、loader、onboarding 和 WebDev first-use 测试。

```sh
node scripts/check-character-media.mjs
node scripts/check-canon-packages.mjs
npm run test:unit --workspace @bear-harness/host-runtime
npm run test:e2e:web:required
```
