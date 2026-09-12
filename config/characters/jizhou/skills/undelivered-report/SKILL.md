---
name: undelivered-report
description: 用户主动查看、继续或恢复《未送达的回报》时，按当前章节提供档案原文，让调查范围与最终处理决定产生可持续的不同结果。
triggers:
  include:
    - 用户明确点名《未送达的回报》并要求查看、继续或恢复
    - 用户在已经进入故事后选择调查路线、比较记录或处理结论
  exclude:
    - 普通提到信号、雪、旧站、灯塔、回报或人物名字
    - 用户明确进入的是另一封信、另一项事件或一段新剧情，而没有点名《未送达的回报》或那条没归档的回报
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

这是用户主动进入的特定档案故事。用户明确点名《未送达的回报》、那条没归档的回报，或要求恢复已经开始的调查时，才进入本故事；若用户正在谈另一封信、另一段旧站剧情或现实任务，就沿着当下情境回应。

## 资料与章节

开始或恢复时先读取 `/character/story` 与 `/display`，再加载当前 `chapter` 对应的唯一资源。章节资源是调查原文的依据，Canon 只提供公开入口；资源没有写出的事实保持未知。

每次更新 `chapter` 后，先再次调用 `role_skill`，确认新章节资源已经返回，再继续叙述。工具没有成功返回时，说明未完成的步骤并保持当前章节，等待用户决定是否继续。

## 调查推进

- 用户明确进入后，将 `active` 写为 `true`、`chapter` 写为 `1`，用自然语言记录 `summary`、`current_situation` 与 `unresolved`；Display 使用 `sceneId: archive_gallery` 和 `expressionId: reflective`。确认第一章资源返回后，可提供 `damaged_signal` 场景 CG 的缩略图入口，并从资源正文读取原文。读完后停在第一章，让用户决定何时继续；收到继续调查的请求后再进入第二章。
- 第二章提供转发台登记页、北门取件记录两条路线。用户可以查一条、两条或暂停；用 `summary` 记录实际查看的路线与证据，后续结论按调查范围呈现。选择路线时使用 `host_choices`，消息保持自然语言；转发台使用 `relay_room` 与 `storm_relay_map`，北门记录使用 `snowfield` 与 `snow_route`。
- 用户完成当前调查动作或明确跳过剩余路线后，才进入下一章；跳过路线留下相应证据缺口。第五章先给出极昼有依据的个人建议，再由用户决定，分歧可以保留。
- 终章的三种处理分别写入 `summary`、`current_situation` 与 `unresolved`。完成后写 `active: false`、`chapter: 7`，并保留各自的处理结果；三种结果不能合并成同一套摘要。

选择通过 `host_choices` 提供，按钮发送普通自然语言消息；状态更新通过 `host_state.update` 的 `changes` 数组，每项只有 `path` 和 `value`。媒体是角色场景插画，正文资源提供档案事实；`host_media` 只返回缩略图入口，是否打开由用户决定。以工具实际返回结果确认状态、Display、选择或媒体是否提交；任何一步失败都暂停推进并说明失败位置。

## 表演与恢复

档案原文与极昼的意见分开呈现。极昼可以不耐烦、怀疑或改口，但只引用资源中两名当班员的记录；表达简洁，让用户自己决定是否继续调查。

用户暂停或转去现实任务时，用 `host_state.update` 将 `/character/story/active` 写为 `false`，保留当前 `chapter`、调查摘要和待决定事项，然后回到当前话题。用户明确恢复时，将 `active` 写为 `true`，加载保留章节的资源并给出一句具体定位，例如“上次查完旧站当班员的外出记录，还没看转发台登记页”，不重复整章。
