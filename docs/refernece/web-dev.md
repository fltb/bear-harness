# WebDev

## 用途

`@bear-harness/web-dev` 是本地浏览器开发和 Playwright 验收外壳。它运行与 Desktop 相同的 protocol、HostRuntime 和 Companion UI，但使用 loopback HTTP/NDJSON adapter。它没有公网认证、TLS、租户或 rate-limit 模型，不得部署为公开服务。

入口：

- [`apps/web-dev/server/index.ts`](../../apps/web-dev/server/index.ts)：本地 Host；
- [`apps/web-dev/src/http-client.ts`](../../apps/web-dev/src/http-client.ts)：browser transport；
- [`apps/web-dev/e2e`](../../apps/web-dev/e2e)：required/live Playwright journeys。

## 传输

```text
Browser UI
  ├─ GET /bootstrap
  ├─ POST /rpc/<versioned-channel>
  ├─ POST durable event NDJSON subscription
  └─ POST /live/pi (transient NDJSON)
         │ process-local bearer token
         ▼
Loopback Node Host -> Dispatcher -> HostRuntime
```

bootstrap 只用于交换产品配置和进程级 bearer token，不包含所有 conversation detail。除了 bootstrap，Host route 都必须验证 token。RPC error 分类与 Electron 保持一致。

durable event stream 带 seq，用于 query invalidation；Pi stream 带 session id，不持久化且不承诺重播。流断开时 server 清理 response/listener；browser 重连后读取可见会话 snapshot。

## 数据目录

手工运行使用产品的开发数据目录；设置 `BEAR_WEB_DEV_DATA_DIR` 可以显式隔离。E2E launcher 为每个进程创建独立 scope，并根据成功/失败 retention policy 清理或保留证据。并行测试不能共享 `settings.db` 或角色 runtime。

WebDev 与桌面端使用同一套正式目录和数据库模型。

## Artifact 的 Web 行为

浏览器可以通过 Artifact 有界 read 进行安全 preview，并把已验证字节下载到用户选择位置。native open/reveal 在 Web 环境返回明确 unsupported；UI 不能拿内部 CAS URL 模拟原生能力。

## 命令

```sh
npm run dev:web
npm run build --workspace @bear-harness/web-dev
npm run typecheck --workspace @bear-harness/web-dev
npm run test:unit --workspace @bear-harness/web-dev
npm run test:e2e:web:required
npm run test:e2e:web:live
```

required suite 不依赖外部真实模型；live suite 在运行前由 `scripts/require-live-model-env.mjs` 验证环境。

## 真实点击验收

浏览器验收不能只调用 Host API，需要在 UI 中真实点击并观察：

1. 首次 System Onboarding/Settings，配置 provider、模型池、网络和 embedding；
2. 新角色 Character Onboarding，且不重复系统表单；
3. 打开两个 Session，让两者并发运行；
4. 在第一个仍流式输出时切到第二个，再切回确认投影连续；
5. 启动后台 Run，保持当前会话不被结果抢焦点；
6. 选择完成 Run/Artifact，预览或 Web 下载；
7. 分别用 `>=1600`、`768..1599` 和 `<=767` 视口确认双列、drawer、全屏；
8. 关闭结果，执行 rename、archive、delete；
9. 重启 WebDev，确认系统设置、角色 onboarding、Catalog、memory 和未清理资源恢复正确。

失败时保留 browser screenshot、console/network error 和对应角色 diagnostics，不能只引用自动化通过数量。
