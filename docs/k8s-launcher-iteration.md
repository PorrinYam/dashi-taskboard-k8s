# K8s 分支 launcher 持续迭代流程

上游 `dashi-taskboard` 是单机 SQLite 应用，本分支把它改造成 PostgreSQL 多副本 + 每设备凭据的
K8s 共享看板，并且要作为 macOS launcher 安装到设备上驱动 Codex 注入。两边同时在动，所以每次
上游发版都要重复合并、验证、构建、安装。本文只记录**反复出现的坑**和**确切命令**。

## 每次上游发版

```bash
# 1. 合并上游
git fetch origin && git merge origin/main

# 2. 解冲突：先看下面那张表，冲突方向和每次基本一致
# 3. 全量测试（必要但不充分，见下）
npm install && npm run typecheck && npm test

# 4. PostgreSQL 闸门 —— 这一步不能省
DATABASE_URL=postgres://<user>@<host>:<port>/<disposable_db> node scripts/verify-postgres.mjs

# 5. 构建并安装隔离版 launcher
node scripts/build-k8s-launcher.mjs --install
```

第 4 步存在的原因：上游代码假定存储访问是同步的，本分支的 PostgreSQL 后端返回 Promise。
未 `await` 的调用在 SQLite 下**测试全绿**，只有真实 PostgreSQL 才会暴露。`npm test` 通过
不代表 K8s 部署可用。

## 反复出现的冲突点

| 位置 | 上游方向 | 分支方向 | 解决原则 |
|---|---|---|---|
| `package.json` / lock | 加 `prosemirror-*` | 加 `pg` | 取并集，再 `npm install --package-lock-only` |
| `server/ai-chat.mjs` | 重构出 `#runtimeForTarget` / `#startAppServerRun`，全程同步存储 | `#gate` 同步/异步兼容层 | 以**上游结构为骨架**，把 `await` 与 `runnerHost` 重新套进新增代码 |
| `server/app.mjs` 请求管线 | `parseRequestHost` 严格校验 + `configuredTrustedRequest` 返回值 | `TRUSTED_HOSTS` 白名单 + `authenticateBoardRequest` | 采用上游校验；`trustedHosts` **只放宽准入，不参与 `configuredTrustedRequest` 判定**，否则共享看板部署会被锁在自己的 `/api/local`、`/api/device-workspaces` 之外 |
| `server/app.mjs` 自动合并区 | 新增分支里直接 `database.getProject(...)` 不 await | 周边代码全部 await | **自动合并区同样要扫**，git 不报冲突不等于正确 |
| `scripts/codex-injector.mjs` | 更新后重注入等大改 | 配对自愈、僵尸面板治愈 | 多为自动合并，但必须跑 `inject` / `injector` 两组测试 |

扫未 await 调用时，这几种形态是**正确**的，不要改：`return this.database.x()`、作为 `#gate(...)`
第一个参数、被 `Promise.all([...])` 收集、处在 `await (cond ? a() : b())` 内、以及由消费方 await
的惰性 thunk。

## 隔离安装

`src-tauri/tauri.k8s.conf.json` 让分支包与上游包并存：

- 独立 bundle id `com.chuspeeism.codex-taskboard.k8s` 与产品名
- 独立数据/日志目录，由编译期 `TASKBOARD_INSTANCE_SUFFIX` 决定；不加这个开关，两个 launcher
  会共用同一个 `taskboard.sqlite` 并互相覆写 `launcher-runtime.json`
- updater endpoints 置空，防止分支包被上游发布静默替换
- 端口不需要处理，launcher 本身会在 47823 被占时回退到空闲端口

**注入权是独占的**：两个 launcher 不能同时活跃，都会重启 ChatGPT 去抢 CDP。切换前先退出另一个。

## 尚未补齐

- **签名与公证**。本机无 Developer ID 身份、无公证凭据，仓库 `PorrinYam/dashi-taskboard-k8s`
  一个 secret 都没配，而 `release-macos.yml` 需要 10 个（`APPLE_CERTIFICATE`、
  `APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_API_KEY`、`APPLE_API_ISSUER`、
  `APPLE_API_PRIVATE_KEY`、`KEYCHAIN_PASSWORD`、`TAURI_SIGNING_PRIVATE_KEY`、
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`、`RELEASE_RULESET_TOKEN`）。补齐后正式产物应走 CI 打 tag，
  本地 ad-hoc 构建只用于自机验证。
- 本地构建只出 `aarch64-apple-darwin`。`app:build` 的 universal 目标需要 x86_64 stdlib，
  Homebrew 版 Rust 没有，要 rustup 或改 CI 构建。
- 分支包的 updater 指向被清空状态；将来若走 CI 发布，应改指本仓库 releases 并配 updater 签名密钥。
