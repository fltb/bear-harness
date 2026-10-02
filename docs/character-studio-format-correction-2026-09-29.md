# 角色包编辑原型：格式校正

> 已被角色包 v2 取代的历史记录。下文 Canon sources/entities/modules、旧角色文案字段与旧状态约束不再是现行格式。请使用 [当前作者文档](character-package-authoring.md) 和 [实际 Studio 实现](character-studio-implementation-2026-10-02.md)。

本文件校正此前 Studio 方案和 v1/v2 原型的字段映射。此前原型中的概括用语、示例结构与轻量校验不能作为真实角色包格式依据。权威仍为当前源码与角色包，不由原型定义新格式。

## 真实来源

- `packages/host-runtime/src/companion/character-loader.ts`：CharacterManifestSchema、包加载与引用校验。
- `behavior-schema.ts`、`onboarding-schema.ts`、`media-schema.ts`、`state-schema.ts`、`theme.ts`：对应角色字段。
- `packages/host-runtime/src/canon/package-schema.ts`：Canon sources/entities/modules。
- `packages/host-runtime/src/companion/role-resources.ts`：Skill YAML 头部和 Markdown 资源加载。
- `config/characters/jizhou/`：本次原型使用的原始文本及实际文件清单，未改写角色内容。

## 必须纠正的映射

| 旧原型问题 | 实际格式 |
| --- | --- |
| 把模块称为“专题”，省略类型和绑定范围 | Canon `modules` 有 id、parent、kind、title、summary、triggers、bindings；kind 为 root/arc/event/entity/relationship/location/object/behavior；bindings 包含 source、headings、start_offset、end_offset |
| 把实体缩成“人物与地点”，类型固定几项 | `entities.kind` 是自由字符串；另有 id、name、aliases、description |
| 知识页只保留标题和正文 | `sources` 还包含 id、path、kind（original_text/reference）；界面维护记录，作者无需另写清单 |
| 首次见面使用 options/id 与 placeholder | `choice` 使用 answer_key、choices[{value,label,description}]；`text` 使用 answer_key、input_label、input_placeholder、min_length、max_length、submit_label；三类共有 quote/note/effects 等，choice 没有 submit_label |
| 允许任意中文技能 name 且缺少必填项仍通过 | Skill name 有英文标识约束；triggers.include/exclude 与 allowed-tools 等有实际最小项数限制；priority 有数值范围 |
| 技能只编辑用途和正文 | 保留 requires、active-when、resources、allowed-tools、completion、priority 及 Markdown 正文。资源有 id/path/headings/when |
| 把 system_prompt 改叫补充指引 | 独立的 system_prompt，展示为“系统提示词”；不并入 behavior.identity |
| 隐藏 character 中的其他文案 | character 包含 subtitle、greeting、composer_placeholder、correction、work_presentation、first_meeting |
| 状态以简单顶层值模拟真实定义 | 实际极昼包使用嵌套 JSON Schema。当前 state-schema.ts 还要求顶层分区为 object、叶子有 default；这一实现限制比 AGENTS 中允许简单字段的原则更窄，本轮如实展示源码和实际包，不修改规范或运行时 |
| 强制要求顶层 STORY.md | 当前极昼包没有该文件，当前 loader 也不把它作为必需输入。本轮不新增虚构文件；实际正文在 Canon 与 Skill resources 中 |

## 本次校正原型

从当前源码抽取 CharacterManifestSchema 和 RoleSkillMetadata 的原始声明；直接导入 Behavior、Onboarding、Media、Theme、Canon 的实际 Schema；由这些 Schema 生成表单和枚举，不在原型中另写简化版格式。抽取的来源文件哈希保留在原型目录 provenance.json。

普通字段采用直接中文名称并显示原字段路径。原文入口和表单修改同一份文件草稿。Canon 文档通过表单编辑来源信息和正文，无需另行手工登记清单。不存在的数据不填成示例人物或示例故事。

真实性范围：文本读取为仓库原文；素材只列真实路径、MIME 与大小，未内嵌二进制，未用示意图片替代。草稿仅在预览内存中保存，不写 Host、角色包或运行时。未接模型、正式应用、ZIP 导入导出、真实素材预览，也未声称它们已实现。

检查范围：当前 Character/Canon/Skill 字段 Schema、首次见面附加检查、Canon 引用检查。未执行 Host 的完整路径安全、二进制、状态编译、插件或发布校验；这不是生产包验收器。

剩余交互工作：完整文件事务（含改路径与标识后的引用维护）、状态定义新增编辑、素材操作、可选标量移除、长列表定位与正式持久化仍须实现。此轮优先纠正格式，不能把表单生成等同于完整产品体验。

生产模块修改：0；未修改极昼包、身份、Skill 或知识正文，不构成角色行为发布。发布决定：不发布。验证结果另存 evidence/character-studio-format-prototype-2026-09-29.json。
