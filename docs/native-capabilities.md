# 原生能力与平台包

Bear 的生产路径是 Electron。Native capabilities 按需加载 SQLite、向量扩展、中文分词和本地 embedding 运行时；加载失败必须形成可诊断的能力结果，不能把角色数据切换到另一个目录或静默混用不同维度。

| 能力 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Electron + Node SQLite | required | required | required |
| `sqlite-vec` / `@node-rs/jieba` | packaged native binding | packaged native binding | packaged native binding |
| local embedding runtime | optional | optional | optional |
| native credential protection | Keychain | DPAPI | release policy required |
| open/reveal/save-as | Finder/dialog | Explorer/dialog | file manager/dialog |

embedding 模型二进制与配置属于系统设置；向量库、索引和 checkpoint 属于每个角色目录。某个平台不能加载本地 embedding 时，UI 要明确提示可用模式，不能以共享临时索引降级。

平台包命令：

```sh
npm run package:mac:arm64
npm run package:mac:x64
npm run package:win
npm run package:linux
```

每个平台发布前都要验证 native binding 加载、system/companion DB 读写、角色隔离、Artifact 原生动作、凭据、崩溃诊断、签名和 packaged smoke。
