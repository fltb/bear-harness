# Bear Harness Plan

> **Canonical product plan.** 只记录已经确认的产品决定；未确认的实现细节不写入本计划。

Bear Harness 是用户电脑上的本地 Companion 产品。用户先与熊对话；熊理解意图、维持关系和上下文、提出下一步，并对外部工作的状态与结果负责。默认人格是熟悉用户已授权环境、略带“机魂”玩笑且倾向外派的熊；玩笑不掩盖失败，不贬低用户，也不能伪造事实。

产品由 Host、内置 Pi Companion 和外部 worker 组成。Host 是唯一的状态、权限、证据、记忆和 UI 事实来源。内置 Pi 是 Companion，不直接执行 shell、写入、联网副作用或取得凭据。Pi Worker、Codex 与 Hermes 都是外部 worker：它们只能处理用户确认的委托，不能取得 Companion 的关系记忆或改写产品 UI。

每个对话有自己的历史、上下文和未完成事项；同一 Companion Identity 贯穿这些对话。全局工作栏让用户看见正在运行的外部工作，不把后台对话打断前台。每个外部委托在会话中提供可见的控制台；用户可以 steer、查看输出，必要时直接接管 terminal。系统必须明确区分熊、worker 和用户亲自执行的操作。

长对话以可恢复 checkpoint 压缩，原始历史与证据仍由 Host 保存。持久记忆由 Host 决定可写、可读和可删除；TencentDB MemoryCore 作为随应用打包的本地语义记忆 helper，用于提炼和召回，不能成为产品事实来源，也不能直接暴露给 worker。

用户拥有完整的版本化 Custom System Prompt。`extend` 在默认熊提示词上叠加用户指令；`replace` 完全不注入默认熊提示词。无论哪种模式，Host 的事实、权限、证据、UI 和 worker 隔离均不受 prompt 改写。Core Preset 仅指产品自带的默认 Companion Base Prompt；不假定任何未证实的内置 Guide、工具或能力。

参考 pi-setup 的目标是默认可用，而不是复制其 packages。默认能力由 Host 和产品代码实现；第三方包只可作为外部 Pi Worker 的显式、可见选择，不能进入 Companion。每项新工具、模型能力或市场包都必须先定义权限、用户操作面、证据和失败状态，不能靠 prompt 或角色叙事补齐。

交付顺序：先完成 Host 的会话、委托、证据与控制台闭环；再接入 Pi/Codex/Hermes；然后打包 MemoryCore 和上下文恢复；最后提供默认熊提示词、Custom System Prompt 和 worker marketplace。完成的标准是用户能在多个对话中持续与同一位熊协作、看懂并接管外部工作、恢复上下文与记忆，同时始终分得清哪些是事实、哪些是熊的表达、哪些是外部程序的输出。
