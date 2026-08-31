# TDAI Core

## 边界

`@bear-harness/tdai-core` 是 Host-neutral 的自动关系记忆处理与检索库，源位于 [`packages/tdai-core/src`](../../packages/tdai-core/src)。Host adapter 负责把它绑定到当前角色 runtime；TDAI 不选择角色、不共享 singleton 数据目录，也不决定 UI consent。

显式 `MEMORY.md` 不由 TDAI 编辑。显式用户记忆与自动推断冲突时，显式内容优先。

## 数据层

| 层 | 作用 |
| --- | --- |
| L0 | 受 consent 和过滤规则约束的会话捕获 |
| L1 | 记忆抽取、去重、持久化与索引 |
| L2 | 场景处理与导航结构 |
| L3 | persona/profile 聚合 |

capture、extraction、persona、pipeline、recall、embedding 和 storage 都有明确配置与 bounds。后台任务失败可降级/重试，但不能把未完成 embedding 当作最终完整索引。

## 系统配置与角色数据

embedding provider/model/dimensions、下载源和本地模型 cache 属于系统设置：

```text
system/models/embeddings/
```

每个角色的记录、向量、FTS、checkpoint、scene/persona 数据属于：

```text
companions/<companionId>/memory/tdai/
```

远端 credential 保存在 vault，不进入角色文件。更换模型或 dimensions 后，Host 标记每个角色索引分别失效并分别重建；不复制向量到共享库，也不跨角色检索。

## Backend

本地 SQLite backend 使用 `node:sqlite`、FTS5 和可用时的 `sqlite-vec`；中文 keyword search 可使用 `@node-rs/jieba`。远端 TCVDB backend 仍由 Host 按系统配置建立，但 namespace 和写入必须锁定当前角色。

embedding 不可用时可以明确降级为 keyword 模式；不能悄悄切换到不同维度或另一个角色的索引。local model cache 缺失应产生可操作的 Settings 提示。

## 生命周期

Host 在打开角色 runtime 时建立该角色的 TDAI instance。删除该角色 runtime 或 Host shutdown 时，停止属于该角色的 timer、等待或取消 tracked background tasks、flush checkpoint 并关闭 store。删除一个 conversation 不删除 TDAI；删除角色 runtime 才移除其数据。

## 安全

- capture/recall 受 consent、内容 bounds、timeout 和 exclude policy 控制；
- diagnostics 默认不记录原始对话或 secret；
- standalone model workspace/path 必须 containment 验证；
- remote TLS/API failures 不自动重复不确定写入；
- retention 清理只处理当前角色已验证目录。

## 验证

```sh
npm run build --workspace @bear-harness/tdai-core
npm run typecheck --workspace @bear-harness/tdai-core
npm run test:unit --workspace @bear-harness/host-runtime
```

集成测试至少覆盖两个角色相同关键词不互相召回、embedding dimension 变化逐角色重建、keyword fallback、consent off、关闭时后台任务清理和显式 Memory 优先。
