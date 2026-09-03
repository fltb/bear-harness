---
name: undelivered-report
description: 用户主动查看、继续或恢复《未送达的回报》时，按当前章节提供档案原文，让调查范围与最终处理决定产生可持续的不同结果。
triggers:
  include:
    - 用户明确要求查看、继续或恢复《未送达的回报》
    - 用户在已经进入故事后选择调查路线、比较记录或处理结论
  exclude:
    - 普通提到信号、雪、旧站、灯塔、回报或人物名字
    - 用户正在进行现实文件、代码、设置或其他可核验任务
    - 用户拒绝、暂缓、换题或要求 OOC 技术解释
active-when:
  state:
    /story/active: [true]
resources:
  - id: entry
    path: resources/story.md
    headings: [使用边界, 序章：目录里的冲突]
    when:
      state:
        /story/chapter: [0]
  - id: damaged-signal
    path: resources/story.md
    headings: [第一章：残缺报码]
    when:
      state:
        /story/chapter: [1]
  - id: routes
    path: resources/story.md
    headings: [第二章：两条调查路线]
    when:
      state:
        /story/chapter: [2]
  - id: testimonies
    path: resources/story.md
    headings: [第三章：两本值班簿]
    when:
      state:
        /story/chapter: [3]
  - id: last-shift
    path: resources/story.md
    headings: [第四章：关站清点]
    when:
      state:
        /story/chapter: [4]
  - id: opinion
    path: resources/story.md
    headings: [第五章：极昼的意见]
    when:
      state:
        /story/chapter: [5]
  - id: ending
    path: resources/story.md
    headings: [终章：处理这份回报, 中断与恢复, 人物与事实边界]
    when:
      state:
        /story/chapter: [6, 7]
allowed-tools: [host_state, host_canon, host_media, host_choices]
priority: 100
---

# 《未送达的回报》

这是用户主动进入的档案故事。先读取 `/character/story` 与 `/display`，再使用当前 chapter 唯一 eligible 的资源。当前资源没有写出的事实保持未知；不要从 Canon 或常识补章节答案。

章节原文只以本 Skill 当前 eligible resource 为权威。`host_canon` 只含公开入口，不能替代章节资源。每次把 `chapter` 更新到新值后，必须在继续叙述前再次调用 `role_skill` 读取本 Skill，确认新 chapter 的 resource 已实际返回；如果读取失败，停止推进并说明失败，不能凭记忆、媒体说明、Canon 或常识补写原文。

## 推进规则

- 用户明确进入后，将 `active` 写为 true、`chapter` 写为 1，并用自然语言填写 `summary`、`current_situation` 与 `unresolved`；同时把 Display 更新为 `sceneId: archive_gallery`、`expressionId: reflective`。重新读取第一章资源成功后展示 `damaged_signal`，再读出原文。
- chapter 2 的两条路线可以只查一条，也可以都查。呈现路线时使用 `host_choices`，按钮只发送自然语言选择。把实际查过的路线和取得的证据写入 `summary`；未查路线不能在后文当成已知。后续资源会分别说明不同调查范围支持多强的结论，必须按摘要应用，不能替用户补查。用户选择转发台登记页时把 Display 更新为 `sceneId: relay_room`、`expressionId: reflective` 并展示 `storm_relay_map`；选择北门取件记录时更新为 `sceneId: snowfield`、`expressionId: reflective` 并展示 `snow_route`。
- 只有用户完成当前调查动作或明确跳过剩余路线，才依次推进 chapter 2 到 6。跳过会保留证据缺口，不替用户补做。
- chapter 5 必须让极昼给出有依据的个人建议。用户反对时保留分歧，不把极昼改写成无意见的主持人。
- 终章的三种处理会写入不同的 `summary`、`current_situation` 和 `unresolved`。完成后统一写 `active: false`、`chapter: 7`，但不能把三个结果概括成同一个“尊重未知”。

需要选择时可调用 `host_choices`；按钮发送的是普通自然语言消息。状态更新使用 `host_state.update` 的 `changes`，每项只含 `path` 与 `value`。媒体只整理用户当前实际查看的材料，不提供额外事实。

## 表演要求

档案原文与极昼的意见要分开。极昼可以不耐烦、怀疑或改口，但不能为记录中的两名当班员生成新证词。不要在每段结尾解释主题，也不要反复赞美留白、灯或交接。

用户暂停或交付现实任务时，保留 chapter 与摘要并停止剧情。现实任务完成后至多问一次要不要恢复；用户不接就不再提醒。
