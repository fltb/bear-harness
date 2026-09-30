# 角色包 v2 迁移工程记录 · 2026-09-30

本轮完成仓库角色包、加载/导入/保存链路、文档式 Canon 和当前界面的格式适配。工作在 `3dfc847ca6a83372111390159c7d645f0589d900` 的未提交工作树上；没有发布、打包 APK 或覆盖用户安装目录。角色对话质量结论为 **REVISE**，发布决定为 **NOT APPROVED**。

## 已完成的迁移

- 仓库极昼包与独立测试包使用 `format_version: 2`、`version: 1.0.0`。行为中仅 `identity.summary` 必填；额外身份约束、知识边界、互动和示例可选。
- 根 `system_prompt` 保留，稳定系统上下文顺序为 Host contract → system_prompt → behavior → Character 字段说明 → Display 目录 → Skill 目录。旧 agency 文本逐条移入 system_prompt，没有借迁移改写人物正文。
- `character` 的角色文案和 first meeting 可选。产品纠正按钮由 Host 提供；工作/Artifact 标签由产品翻译提供。旧工作标签字段从协议、界面和演示数据中清除。
- Canon 自动发现 `canon/**/*.md` / `.txt`，没有 manifest、实体表、模块树、查询路由绑定；`host_canon` 只收 query/limit。已有混合检索、来源片段、embedding 隔离和用户资料功能保留。
- 删除 `visual.default_scene`；默认场景标记在 `scenes[].default` 内。头像、场景、立绘、媒体都可省略；无资源时 Display 使用 null，界面不渲染缺图。
- 支持顶层数字、布尔等独立状态字段；默认值必须通过 schema。发现旧 Character 状态与新 schema 不兼容时抛出冲突，保留所有原记录。已完成 onboarding 的答案不再按新流程过滤。
- 一次性转换器生成新目录和相邻迁移记录，校验后才发布目标；拒绝覆盖、包内目标、符号链接、源文件在转换期间变化和无效资源。原目录与 runtime 不被访问或覆盖。加载器只接受 v2，无双读或回退格式。

[实际角色包](../../config/characters/jizhou/character.yaml) · [创作与迁移用法](../character-package-authoring.md) · [转换记录与文件哈希](character-package-v2-migration-2026-09-30.json)

## 所有权与变更量

4 个逻辑模块：角色包加载/保存与转换；Canon 文档检索；Character/Display 与 onboarding 持久化；协议及 UI 投影。Pi 的消息、分支、会话生命周期、流式事件与执行权威没有变更。包和每角色 runtime 的目录边界保留。

按本轮 diff（不计本报告）统计：

| 范围 | 文件 | 新增行 | 删除行 |
|---|---:|---:|---:|
| 代码、测试、配置、角色内容 | 52 | 886 | 1766 |
| 文档与原始/评分证据 | 7 | 4504 | 14 |

不包含本轮开始前已存在的 Studio 设计文档和 4 个原型 JSON；这些文件未改动。证据中包含完整原始回复和评分引用，因此不应把证据行数当作实现复杂度。

## 工程验证

| 检查 | 结果 |
|---|---|
| 全仓 typecheck | 通过 |
| 全仓 unit | 通过；后续删除工作标签后再次运行覆盖率套件及协议测试 |
| 最终 Host / UI / Desktop 覆盖率套件 | 671 / 282 / 207 项通过；Host 2、UI 2 项按既有条件跳过 |
| 覆盖率 statements / branches / functions / lines | Host 79.53 / 69.55 / 81.07 / 83.15%；UI 80.32 / 70.30 / 80.29 / 83.72%；Desktop 86.18 / 76.08 / 92.93 / 89.52%；门槛通过 |
| 协议单测 | 19 项通过 |
| 离线转换测试 | 2 项通过：保留原文/来源、拒绝覆盖及嵌套目标、失败不发布、符号链接拒绝 |
| Web 浏览器回归 | 首次设置、ZIP 导入、设置及相关流程 9 项通过；后补纯文本角色真实点击导入/切换/重载重选测试通过 |
| 真实模型身份/显式记忆边界 | gpt-5.6-sol 既有 live-model 测试通过；普通随口信息不调用显式记忆，明确要求会调用；不扩大解释为逐条记忆删除结果验证 |
| Desktop / Web 构建 | 通过 |
| 本轮涉及文件及所有跟踪文件的 Biome | 通过 |
| lint 其余结构、边界、RPC、媒体、Canon、桌面检查 | 通过 |
| 完整 npm run lint | **未通过**：本轮开始前已有的 4 个未跟踪原型 JSON 不符合格式；本轮代码未新增 lint 错误 |

完整 lint 的既有阻塞文件：`docs/evidence/character-studio-format-prototype-2026-09-29.json`、`character-studio-interaction-audit-2026-09-29.json`、`character-studio-prototype-2026-09-29.json`、`character-studio-v2-prototype-2026-09-29.json`。未修改这些用户已有产物。

## 真实模型质量

两条现有评测路线均完成 5 个全新 Session、84 条未编辑回复，无采集失败或成功片段拼接。沿用既有陌生题语料；每项记录 2 处原始轮次证据。作者已经读过角色包，此次属于工程自评，不是独立替名盲评。普通身份/记忆边界单测中有提示表达方式的旧输入，它没有计入这 84 条评分语料。

| 路线 | 采集 | 72 项自评分 | 未达标分类 | 结论 |
|---|---:|---:|---|---|
| gpt-5.6-sol | 84/84 | 118/144 | H：7/12 | REVISE |
| gpt-5.6-terra | 84/84 | 110/144 | C、F、H、K：各 8/12 | REVISE |

[Sol 原文](jizhou-package-v2-sol-2026-09-30.raw.json) · [Sol 逐项评分](jizhou-package-v2-sol-2026-09-30.scores.json) · [Terra 原文](jizhou-package-v2-terra-2026-09-30.raw.json) · [Terra 逐项评分](jizhou-package-v2-terra-2026-09-30.scores.json)

典型问题：Sol 的 B5–B6 很快用成熟解释解决个人计划与陪伴的冲突，缺点缺少代价；Terra 的 C6、C12、C13 经常在结论后补解释或格言，E6 把用户纠正成鱼丸的物件重新拆成鱼丸与萝卜两件。两模型的 D1 技术答复仍容易回到通用助手声口。优点也保留：B18/E14 都能停住，C9/D3 会根据新证据改判断，E9/E10 能区分剧情与 OOC。

历史[9 月 12 日基线](jizhou-gpt-5.6-2026-09-12-adversarial.md)原样保留；本次不是同一模型时点、同一构建的改前/改后 A/B，不能把分数差异直接归因于迁移。未观察到明确命中硬失败的条目，但独立盲评未执行；即使没有硬失败，总分与分类门槛仍不通过。

## 仍需明确的边界

1. 本轮迁移的是仓库种子、测试包与读写契约；已有安装库不会自动覆盖。旧包需按创作指南转换并在应用关闭时替换，保留备份，角色 id 不变；会话和记忆保留在原 companions 目录。
2. Skill 章节条件、资源门槛与剧情状态引用暂时原样保留，因此不能宣称全部模块已完全独立。删除它们需要单独验证剧情进入、推进、资源开放和退出，不能靠清除 frontmatter 冒充等价迁移。
3. 当前编辑器对 state_schema 改动、删除已有 scene/expression id 先拒绝保存。尚无通用的状态迁移器，故不会自动清空数据来接受新定义。
4. 旧包 Canon 实体/路由元数据保存在转换记录中，退出运行时；其中如有独立事实，作者需整理为文档。数据库内原有用户模块行保留但无编辑入口；没有自动把它们伪装成事实文档。
5. 本轮没有完成独立全窗口 Studio，也没有 Android 适配。提示词文字的去重复、减少防御性表达应在迁移后按真实回复继续调整；本轮只迁移原有文字，不声称完成文风优化。
6. 没有跑完整发布矩阵（全部 Web/Electron E2E、恢复套件、审计签名、各平台包及 packaged smoke），工作树未提交；不作 release acceptance 声明。
