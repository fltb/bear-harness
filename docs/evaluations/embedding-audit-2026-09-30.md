# Embedding 状态核查 · 2026-09-30

后续更新：用户授权后，真实默认安装已完成迁移，新角色包、Canon 和记忆向量均已生效，旧会话保留。见 [实际安装迁移记录](installation-migration-2026-09-30.md)。以下保留本阶段原始结论。

本页保留修复前的核查结论。用户随后授权直接接通向量，后续实现、真实模型验证和旧安装库限制见 [Canon 向量修复记录](canon-embedding-2026-09-30.md)。

用户在角色包重写期间询问已设置的 embedding 是否工作。本次只读检查默认安装目录，没有修改用户设置、凭据、会话、记忆或索引。

## 实际落盘证据

检查目录：`~/Library/Application Support/bear-harness/`。这是当前产品代码声明的默认桌面/WebDev 数据目录；未发现默认 WebDev 端口上的活动服务，不能由这份历史数据断言当前前台应用正使用该目录。

| 项目 | 读到的值 |
| --- | --- |
| `system/settings.db` 的 embedding 配置 | `enabled: true`、`provider: local`、`localModel: embeddinggemma` |
| 设置记录时间 | `2026-08-30T18:10:41.044Z` |
| TDAI 模型记录 | EmbeddingGemma 300M Q8_0，768 维 |
| `companions/jizhou/memory/tdai/vectors.db` | 20 条 L0 会话记录/向量行，2 条 L1 记忆记录/向量行 |
| `companions/jizhou/runtime.db` Canon | 1 个来源、10 个文本块、0 个 embedding blob、0 个向量索引行 |
| Canon 向量元数据 | 768 维及模型指纹已建立；元数据存在不代表文本已向量化 |
| 当前安装级 `system/models/embeddings/` | 空目录；未据此断言旧模型在其他缓存中不存在 |

这些记录支持“embedding 曾用于记忆”，不支持“当前 Canon 已完成向量索引”。没有重新加载真实本地模型、没有重新生成向量，因此不声称当前模型调用成功。未读取或输出 API 密钥。

## 当前代码中的缺口

1. `character-runtime.ts` 中提供给 `host_canon` 的回调调用 `canon.retrieve()`，只走文字检索。`ContextPackCompiler.compileForTurn()` 则调用 `retrieveHybrid()`，两条入口不一致。
2. Canon 的 embedding 服务由 `memoryRuntime.getEmbeddingService()` 提供；`TencentDbRuntime` 尚未启动时返回 undefined。记忆主要在被调用时启动，并且受角色记忆开关影响。
3. 角色后台 reconciliation 调用 `indexPending()`，但 embedding 尚未 ready 时直接返回。`retrieveHybrid()` 会生成查询向量，却没有先补建待索引文本，也没有在此处注册“模型 ready 后补建”动作。索引函数里的“下次检索重试”注释不对应实际调用链。
4. `indexPending()` 捕获异常后直接返回，因此仅凭模型设置或索引元数据，用户无法知道这次是否完成了 Canon 索引。

当前应按“记忆有历史成功证据；Canon 接线和索引生命周期未完整验证”处理。下一项修复应使 Canon 使用安装级 embedding 能力，与自动关系记忆的同意/采集开关独立；模型就绪后补建角色自己的索引，并使主动查资料与自动上下文检索走同一混合检索入口。还需呈现可核对的就绪、待处理、失败与已索引数量，并用已配置模型做一次真实语义检索验证。这些属于后续实现，本次没有把它们描述为已经修好。

## 与本轮角色验证的关系

角色质量脚本在独立临时目录完成 onboarding 时选择 `choice: none`，未复制用户的 embedding 配置。这轮模型实测验证的是 Canon 文字检索、Skill 和实际回复；向量算法只有已有单元测试中的可控向量服务覆盖。它不能替代真实 EmbeddingGemma 验证。

本轮修复了混合长短中文关键词丢弃短词的问题。这对未配置、启动未完成或向量服务不可用时的文字检索有效，但不等于补好了 embedding 的初始化与索引生命周期。
