# 角色包创作指南

这份指南面向社区创作者。角色包是内容格式，不是可执行代码，也不是可以绕过系统限制的提示词集合。数据、工具、权限、记忆和对话历史始终由 Host 管理。
角色包声明的内容属于 Host 的 **role-package storage bucket**，不是用户记忆。包内的常量、素材和资源由 Host 读取、校验、投影和隔离；作者不能把它们当作关系档案或记忆输入。

## 从最小包开始

```text
my-character/
  character.yaml
  assets/
    avatar.png
```

最小可用包应声明 ASCII `id`、显示名称、头像、`identity_core`、`style`、`character`、一个场景和一个表情。完整范例见 `config/characters/jizhou/character.yaml`。

`identity_core` 只写稳定事实：角色是谁、知道什么、不能跨越什么边界。说话习惯写进 `style`。不要写入用户隐私、临时剧情结果、其他会话内容、密钥，或试图覆盖 Host 策略的指令。

## 会进入上下文的内容

每轮按以下顺序编译：

1. `identity`：角色包的 `identity_core`。
2. `canon`：角色自传与检索到的原作证据。
3. `story`：当前分支已确认的故事变化。
4. `scene`：本会话场景和表情状态。
5. `roleplay`：声明的剧情变量和解锁项。
6. `relationship`：用户已批准且已开启的关系记忆。
7. `conversation`：当前采用分支的消息历史。

当前用户消息单独附加。编辑用户消息会创建新采用分支，旧分支 transcript 不得进入下一轮请求。其他会话不会自动注入；只有用户明确要求且开启授权后，角色才能调用 `host_search_conversation_history` 检索。

## 角色包存储与关系记忆边界

`character.yaml` 及其包目录是 Host-owned role-package storage。以下内容都属于角色包存储：

- **常量**：`theme`、`character`、`identity_core`、`self_canon`、场景、视觉、`host`、`companion` 和 `roleplay` 声明。
- **素材**：头像、表情、场景背景，以及 `roleplay.media` 引用的媒体、海报和字幕。
- **资源**：`canon/`、`skills/`、`plugins/` 及其包内文件。

Host 可以把选定的包内容投影到指定的 `identity`、`canon`、`scene` 或 `roleplay` 上下文层，也可以把素材投影给渲染器、把 Skill/插件资源提供给 Pi；这不会改变它们的存储归属。包声明的常量、素材和资源 **不得** 写入 `relationship` 记忆、自动记忆捕获（automatic memory capture）、用户记忆面板记录（user memory panel records），也不得作为长期记忆后端输入（long-term memory backend inputs）。它们不能成为待批准的记忆候选，也不能通过记忆编辑、置顶、排除或召回入口出现。

关系记忆是用户明确批准后由 Host 单独保存的共同经历、称呼和偏好。它与角色包目录、包内文件和包声明值是两个不同的数据来源；关闭关系记忆只影响关系记忆，不删除或改变角色包存储。

## 变量与剧情

`roleplay.variables` 只有三种 scope：

| Scope | 含义 | 适用内容 |
| --- | --- | --- |
| `conversation` | 仅当前会话可见。 | 临时场景、局部谜题。 |
| `relationship` | 同一角色的所有会话共享。 | 信任、熟悉度、共同偏好。 |
| `character` | 角色的持久事实。 | 已完成章节、已发现世界事实。 |

`global` 非法，会被拒绝。事件是 append-only 的 Host 账本：只能修改已声明变量、解锁已声明素材、切换已声明展示。事件不能访问文件、网络、权限或创建未声明变量。只有 `main` transcript 可以提交角色事实；其他分支仅用于文本探索。

## 记忆、技能与素材

关系记忆归用户所有。角色包不能强制批准，不能读取待审核或被拒绝的条目。`skills/<name>/SKILL.md` 应只描述边界明确的任务，并且不得在工具成功前声称状态已改变。所有场景、表情和媒体都必须先声明，并且只能引用包内相对路径。

## 发布前检查

- 通过导入流程校验包结构。
- 验证身份、风格、场景、剧情状态确实进入首轮上下文。
- 按顺序触发每个事件，检查值和解锁项。
- 编辑旧用户消息，确认旧分支不影响下一轮。
- 新建第二会话：`relationship`、`character` 应连续，`conversation` 应隔离。
- 关闭关系记忆，确认它从下一轮上下文消失但未被删除。
- 确认每个素材、Skill 和媒体引用都被打包。
- 确认角色包常量、素材和资源只作为包存储或指定上下文/渲染/Pi 投影，未进入自动记忆捕获、记忆面板或长期记忆后端。

## 工坊草稿与发布

工坊不会直接覆写角色库中的目录。每次创建得到一个草稿和 revision `1`；保存文件会产生新的不可变 revision。编辑器提交时必须携带自己读取到的 `expectedRevision`。若其他编辑先保存过，Host 返回 `character_draft_revision_mismatch`，编辑器必须重新读取，而不能静默覆盖。

工坊直接选择、预览和替换图片。图片沿用对话附件的 `path + mime + base64` 传输约定；文本编辑器只处理文本。Host 在草稿 revision 内部保留精确字节，因此预览、校验和发布使用同一份素材，不会因字符串转换损坏 PNG、WebP 等文件。

推荐的工坊操作顺序：

1. `character.draftCreate:v1` 创建草稿，可记录原型角色的 `basePackageId`。
2. `character.draftPatch:v1` 保存一批文件，得到新的 `currentRevision`。
3. `character.draftValidate:v1` 携带该 revision。Host 会在临时目录按正式导入规则完整解析，成功后状态变为 `ready_to_publish`。
4. `character.draftPublish:v1` 再次携带同一 revision。Host 会再次校验、原子安装角色包、将草稿置为 `published`，并激活新角色。

校验不写入角色库，发布才是副作用边界。发布中的同名角色包会报冲突，不能覆盖已经安装的包；请使用新的稳定 ID 和版本，而不是把不同人物伪装成一次更新。工坊 Agent 只能调用这些受限 Host 操作来形成建议或补丁，不能自行发布、读取本地文件或改写其他对话。

## 社区约定

使用稳定的创作者前缀 ID，明确维护版本和改动记录，标注文字与视觉素材来源。角色包不得暗示自己能读取用户文件、账户、私密对话或执行现实工具。一个社区包应可独立审查：所有状态转移和素材引用都能从包内容直接看见。
