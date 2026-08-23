# 原生能力与三端发布

白熊客栈将原生模块作为正式安装依赖，同时把其运行结果视为可降级能力，而非应用的启动前提。`@bear-harness/tdai-core` 的
`NativeCapabilities` 统一管理本地 SQLite、向量扩展、中文分词和 llama.cpp 绑定的按需加载。
能力缺失时，应用保留可用的替代路径：向量检索进入降级模式，中文检索使用 Unicode 分词，
本地嵌入失败时使用关键词检索或远程嵌入。

## 支持矩阵

| 平台 | CPU | GPU 优先级 | 发布目标 |
| --- | --- | --- | --- |
| macOS arm64 | 支持 | Metal | universal DMG/ZIP |
| macOS x64 | 支持 | CPU | universal DMG/ZIP |
| Windows x64 | 支持 | CUDA、Vulkan、CPU | NSIS/ZIP |
| Linux x64 glibc | 支持 | CUDA、Vulkan、CPU | AppImage/DEB |

GPU 后端不是独立配置。`node-llama-cpp` 以 `gpu: "auto"` 探测可加载的已打包绑定，
并按平台选择最佳后端；不可用时尝试 CPU。应用传入 `build: "never"` 和
`skipDownload: true`，因此用户机器绝不会在运行时下载 llama.cpp 源码或执行编译。

## 打包约束

桌面构建将以下模块解包到 `app.asar.unpacked`：`node-llama-cpp`、
`@node-llama-cpp/*`、`sqlite-vec*` 与 `@node-rs/jieba*`。原生 `.node` 文件以及 CUDA、
Vulkan、Metal 和 SQLite 所需的共享库由 Node 在解包目录中加载。每个平台只携带该目标的
CPU 与常用 GPU 绑定：Linux 和 Windows 不携带其他系统/架构的绑定，也不携带体积很大的
CUDA `ext` 兼容扩展；标准 CUDA 绑定仍在首期产物中。

发布应在对应目标系统上完成，或在可验证目标架构原生二进制的 CI runner 上完成。每个
安装包至少运行一次 smoke：启动应用、验证本地 SQLite/分词加载、对 llama 进行不下载的
绑定加载检测，并确认关闭时释放资源。模型文件属于用户数据，不随安装包内置；只有用户
启用本地模型后，模型下载或选取流程才可以发生。
