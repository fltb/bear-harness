# 参考索引

本目录描述当前发布架构。历史方案、旧审计结论和已经删除的兼容模型不属于现行契约。

## 推荐阅读顺序

1. [系统架构](./architecture.md)：边界、分层、物理布局和完整数据流。
2. [Host Runtime](./host-runtime.md)：Pi Registry、存储、Character/Display、Runs 和 Artifacts。
3. [Protocol / Schema](./protocol-schema.md) 与 [Companion Client](./companion-client.md)：跨进程契约和临时流。
4. [Companion UI](./companion-ui.md)：响应式投影、双层设置和结果工作区。
5. [Desktop](./desktop.md) 或 [WebDev](./web-dev.md)：具体外壳及验收方式。

## 模块参考

| 文档 | 主要问题 |
| --- | --- |
| [architecture](./architecture.md) | 谁拥有数据，数据怎样流动，角色如何物理隔离 |
| [host-runtime](./host-runtime.md) | Host 怎样管理多个真实 Pi 会话和产品域 |
| [protocol-schema](./protocol-schema.md) | RPC、事件、快照和边界验证 |
| [companion-client](./companion-client.md) | 类型化调用、Electron/WebDev 传输和流式订阅 |
| [companion-ui](./companion-ui.md) | UI 本地 active、Pi 响应式流和 Artifact 预览 |
| [desktop](./desktop.md) | Electron 隔离、凭据、原生文件动作和打包 |
| [web-dev](./web-dev.md) | 回环 Host、浏览器验证和测试数据隔离 |
| [tdai-core](./tdai-core.md) | 自动记忆、embedding 和角色级索引 |
| [product-config](./product-config.md) | 构建时产品身份与发行配置 |
| [i18n](./i18n.md) | 产品文案与角色文案边界 |

补充指南：

- [Character / Display 权威](../host-state-authority.md)
- [角色包创作](../character-package-authoring.md)
- [开发与发布验证](../development-verification.md)
- [原生能力与平台包](../native-capabilities.md)
- [品牌边界](../brand.md)
