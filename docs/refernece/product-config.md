# Product Config

## 职责

`@bear-harness/product-config` 定义构建时产品身份：产品名、app id、数据目录名、artifact filename、executable、默认角色 id、品牌许可证、icon 和 update publisher policy。源码位于 [`packages/product-config/src/index.ts`](../../packages/product-config/src/index.ts)。

它不保存角色名字、故事、人格、场景或 first-meeting 文案；`defaultCharacterId` 只是选择一个角色包。

## 验证

配置验证覆盖：

- reverse-domain app id；
- data/executable/default-character 的 kebab-case；
- artifact filename 所需 macros；
- repo-relative、不可逃逸的 icon；
- CC BY-SA attribution 与 fork modification notice；
- update feed HTTPS；
- Ed25519 publisher public key。

Desktop、WebDev、UI 与 packaging 使用同一配置。构建脚本会验证默认角色包存在；更新 feed 非空时必须同时配置 publisher policy。

## Fork

Fork identity 需要整体修改 product config、图标、默认角色、attribution、安装目录、app id 和发布基础设施。只改显示名会造成升级/数据目录/品牌混淆，验证器应拒绝不完整 fork。

角色 runtime 目录的子层级是固定架构；product config 只决定顶层产品 data root 的名字，不允许为不同服务产生互相不兼容的路径。

## 验证命令

```sh
npm run typecheck --workspace @bear-harness/product-config
npm run build --workspace @bear-harness/product-config
npm run lint --workspace @bear-harness/desktop
```
