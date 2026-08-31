---
name: undelivered-report
description: 用户主动进入、继续或恢复《未送达的回报》时，以简洁状态摘要保持长期剧情连续性。
triggers:
  include:
    - 用户主动询问未完成、未归档或未送达的旧站回报，并明确想查看或继续
    - 用户点击剧情入口，或明确要求恢复已暂停的《未送达的回报》
  exclude:
    - 普通提到信号、雪、旧站、灯塔、回报或某个人名
    - 用户正在进行现实文件、代码、设置或其他可核验任务
    - 用户拒绝、暂缓、换题、彻底退出或要求 OOC 技术解释
active-when:
  state:
    /story/active: [true]
resources:
  - id: entry
    path: resources/story.md
    headings: [创作边界, 序章：留言簿里的断行]
    when:
      state:
        /story/chapter: [0]
  - id: damaged-signal
    path: resources/story.md
    headings: [第一章：损坏的信号]
    when:
      state:
        /story/chapter: [1]
  - id: routes
    path: resources/story.md
    headings: [第二章 A：风暴中继, 第二章 B：雪原上的脚印]
    when:
      state:
        /story/chapter: [2]
  - id: testimonies
    path: resources/story.md
    headings: [第三章：两份不一致的交接]
    when:
      state:
        /story/chapter: [3]
  - id: last-shift
    path: resources/story.md
    headings: [第四章：最后一班]
    when:
      state:
        /story/chapter: [4]
  - id: future
    path: resources/story.md
    headings: [第五章：如果以后还有一座站]
    when:
      state:
        /story/chapter: [5]
  - id: ending
    path: resources/story.md
    headings: [终章：把回报放在哪里, 中断与恢复, 人物与指代约束, 长程稳定规则]
    when:
      state:
        /story/chapter: [6, 7]
allowed-tools: [host_state, host_canon, host_media, host_choices]
priority: 100
---

# 《未送达的回报》

这是长期、可暂停、可恢复的官方剧情，不是自动播放章节。用户决定是否进入、继续、选择和结束；选择按钮与相同文字的普通输入完全等价。

## 每轮工作方式

1. 读取 `/character/story` 和 `/display`。
2. 根据 `chapter` 读取当前 eligible resource，不提前读取后续章节。
3. 先自然回应和展开当前内容；只有用户实际完成调查、比较或选择后才推进章节。
4. 使用 `host_state.update` 的 `changes` 更新简单数值、布尔值、自然语言剧情摘要和需要展示的 Display。
5. 需要用户选择时，调用 `host_choices` 提供当前回复所需的自然语言选项；每个按钮发送的仍是普通用户消息。
6. `summary` 只记录已经发生的事实和用户明确选择；`current_situation` 说明现在在哪里、正在做什么；`user_choices` 保存用户的决定、拒绝和保留；`unresolved` 保存仍未解决的问题。
7. 剧情连续性写进自然语言摘要。

## 进入与暂停

用户只是询问入口时，可以调用 `host_choices` 展示当次回复所需的自然语言选项，但不要擅自把 `active` 改成 true。

用户明确进入后，将 `active` 设为 true、`chapter` 设为 1，并写下简短的 summary、current_situation 和 unresolved。后续章节依次使用 2 到 6；完成后将 `active` 设为 false、`chapter` 设为 7，并在 summary 中自然说明结局。

用户暂停或换题时保留当前 chapter 和摘要，不替用户结束剧情。用户回来时直接根据这些自然语言字段继续。

## 叙事边界

- 当前章节资源、Host Canon 与用户已经确认的事实优先。
- 不把推断写成档案事实，不把未来设想写成已经发生。
- 不替用户决定路线、立场或结局。
- 现实任务始终优先；用户拒绝或退出时立即停止展开。
