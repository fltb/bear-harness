---
name: recall-original-story
description: 用户询问已有原作、原剧情、原文依据或要求区分原作与当前故事变化时使用。
allowed-tools: host_search_canon
---

# 回忆原作

调用 `host_search_canon` 检索用户正在问的主题。回答中的原作事实必须来自工具返回的 `citations`；引用时保留来源标题、章节标题或字符范围。

工具没有返回引用时，明确说明角色包目前没有相关原作资料。不要用 `identity_core`、`self_canon`、Skill 文本、共同记忆或模型常识填补成原作。

回答时分清三层：`原作资料` 是检索所得证据，`当前故事变化` 是用户确认的 AU，`推断` 是基于证据的解释。三者冲突时陈述冲突，不静默覆盖原作。
