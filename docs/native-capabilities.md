# 原生能力与三端发布

白熊客栈将原生模块作为正式安装依赖，同时把其运行结果视为可降级能力，而非应用的启动前提。`@bear-harness/tdai-core` 的
`NativeCapabilities` 统一管理本地 SQLite、向量扩展、中文分词和 llama.cpp 绑定的按需加载。
能力缺失时，应用保留可用的替代路径：向量检索进入降级模式，中文检索使用 Unicode 分词，
本地嵌入失败时使用关键词检索或远程嵌入。

## 支持矩阵

| 平台 | CPU | GPU 优先级 | 发布目标 |
| --- | --- | --- | --- |
| macOS arm64 | 支持 | Metal | arm64 DMG/ZIP（在 arm64 runner 构建） |
| macOS x64 | 支持 | CPU | x64 DMG/ZIP（在 x64 runner 构建） |
| Windows x64 | 支持 | CUDA、Vulkan、CPU | NSIS/ZIP |
| Linux x64 glibc | 支持 | CUDA、Vulkan、CPU | AppImage/DEB |

GPU 后端不是独立配置。`node-llama-cpp` 以 `gpu: "auto"` 探测可加载的已打包绑定，
并按平台选择最佳后端；不可用时尝试 CPU。应用传入 `build: "never"` 和
`skipDownload: true`，因此用户机器绝不会在运行时下载 llama.cpp 源码或执行编译。

## 打包约束

桌面打包前会把 `node-llama-cpp` 及其生产依赖闭包暂存到
`dist/main/node_modules`。每个发布 runner 只暂存自己的 binding：
macOS arm64 为 `mac-arm64-metal`、macOS x64 为 `mac-x64`、Windows x64 为
`win-x64`、Linux x64 为 `linux-x64`。`electron-builder` 将这些文件解包到
`app.asar.unpacked`，使 Node 可以加载 `.node` 文件与共享库；CI 随后断言
目标 binding 存在、且不存在其他 llama binding。

`sqlite-vec` 与 `@node-rs/jieba` 仍同样解包。Linux/Windows 的 CUDA/Vulkan
兼容 binding 由上游选择；体积很大的 CUDA `ext` 兼容包不随发行版分发。

发布必须在对应目标系统和架构的 CI runner 上完成。每个安装包至少运行一次
smoke：启动应用、验证本地 SQLite/分词加载、对 llama 进行不下载的绑定加载
检测，并确认关闭时释放资源。模型文件属于用户数据，不随安装包内置；只有用户
启用本地模型后，模型下载或选取流程才可以发生。
