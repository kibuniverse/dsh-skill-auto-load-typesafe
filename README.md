# dsh-skill-auto-load-typesafe

> Preload DeepSeek Harness skills selected by TypeSafe AI.

独立的 DeepSeek Harness Host 插件。收到用户输入后，通过 `@typesafe-ai/sdk` 调用 TypeSafe AI，为当前 Agent 可见的 skills 批量判断适用性，将选中的完整指令加入同一次主模型请求。

使用独立凭据 `TYPESAFE_API_KEY`，不经过 Harness 的 `ctx.llm`，不改变主模型的提供商或凭据。

## 概要

| 项 | 值 |
|---|---|
| npm 包 | [`dsh-skill-auto-load-typesafe`](https://www.npmjs.com/package/dsh-skill-auto-load-typesafe)，最新版本以 npm 页面和 GitHub Releases 为准 |
| 已验证版本 | Harness `@deepseek-ai/dsh@0.1.5-rc.3`、Cordis `4.0.2`、TypeSafe SDK `0.6.0`、Node `^22.19.0 \|\| >=24.0.0` |
| Harness 依赖范围 | Harness peer dependencies 为 `^0.1.5-rc.3`，允许后续 `0.1.x` 正式版本，不跨到 `0.2.0`；其他 prerelease 版本需要单独验证；Cordis 固定为 `4.0.2` |
| 挂载方式 | Host 单实例；`dsh.bundle.patch` 指向 `cordis.patch.yml` |
| 依赖服务 | `agents`、`skills`、`credentials`、`storageDomain`（base-backed profile 默认提供） |
| 监听事件 | `agent/pre-step`（prepend，先等待其他监听器的决定再追加注入） |
| 凭据 | `TYPESAFE_API_KEY`（Harness 凭据存储或 shell 环境变量） |
| 默认生效 | 仅 `standard` preset 的 Agent；由 `presetIds` 调整 |
| 失败语义 | 临时网络/解析/超时错误默认 `continue` 降级继续；缺 key、认证失败、无效配置明确报错 |

## 快速开始

```sh
# 1. 确认运行环境；当前已验证的 Harness 版本是 0.1.5-rc.3
node --version
dsh --version

# 2. 按 profile 安装（dsh plugin 底层为 pnpm，按包名从 npm 拉取）
dsh plugin --profile web add dsh-skill-auto-load-typesafe

# 3. 从 https://console.typesafe.ai 获取 API key，并任选一种方式配置；
#    最直接的方式是在启动 Harness 的同一个 shell 中设置环境变量
export TYPESAFE_API_KEY='<your-typesafe-api-key>'

# 4. 启动或重启 Harness
dsh web
```

也可以通过 Harness 配置界面或凭据文件持久化密钥，详见下方[配置 `TYPESAFE_API_KEY`](#配置-typesafe_api_key)。完成凭据配置后，默认插件配置即可运行；向 `standard` preset 的 Agent 发送一条用户消息即可触发。调整 preset 范围、阈值、预算等见下方[插件配置](#插件配置)。

启用后，每个符合条件的用户回合会向 TypeSafe 发出一次选择请求，可能产生 API 用量并增加请求延迟。发送和持久化的数据范围见[持久化与数据流](#持久化与数据流)。

## 安装与启用

从 npm 按包名安装（推荐）：

```sh
dsh plugin --profile web add dsh-skill-auto-load-typesafe
```

从本地目录安装（用于开发改动）：

```sh
npm ci
npm run build
dsh plugin --profile web add /absolute/path/to/dsh-skill-auto-load-typesafe
```

也可以在 Harness Plugin Manager 中安装该绝对目录。包的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，安装后在 Host 挂载一个插件实例。替换已安装的代码后需要重新安装并重启 Harness。这里的命令是安装说明，仓库创建和测试不会自动改变任何现有 profile。

默认仅对 `standard` preset 的 Agent 生效；`minimal`、`ptc` 等不自动启用。Host 挂载让多个会话共用审计存储；每次 skill 查询仍传入当前 Agent scope，因此不会混入其他 preset 的 skills。不要在多个 preset 中重复挂载该插件，它的审计 domain 由单一 Host 实例拥有。

### 配置 `TYPESAFE_API_KEY`

先登录 [TypeSafe Dashboard](https://console.typesafe.ai) 创建或复制 API key，然后任选一种方式提供名为 `TYPESAFE_API_KEY` 的凭据：

1. **Harness 配置界面（推荐持久化方式）**：在配置界面保存名为 `TYPESAFE_API_KEY` 的凭据。界面可以显示是否已配置及凭据来源，但不会回显密钥值。
2. **启动环境变量**：在启动 Harness 的同一个 shell 中执行 `export TYPESAFE_API_KEY='<your-typesafe-api-key>'`，再运行 `dsh web`。环境变量只在该进程启动时读取，更换后需要重启 Harness。
3. **本地凭据文件**：编辑 `$DSH_HOME/.credentials.yaml`；未设置 `DSH_HOME` 时通常是 `~/.dsh/.credentials.yaml`。如果文件已经存在，请合并 `refs` 字段，不要覆盖其他凭据：

```yaml
version: 1
refs:
  TYPESAFE_API_KEY: <your-typesafe-api-key>
```

凭据文件应仅允许当前 OS 用户读取：

```sh
chmod 600 "${DSH_HOME:-$HOME/.dsh}/.credentials.yaml"
```

Harness 的凭据解析优先级为：启动环境变量、凭据文件、项目 `.env`、Harness home 下的 `.env`。启动环境变量为只读且会遮蔽其他来源；凭据文件变更会自动重载。插件在每次请求前重新解析 key，因此通过配置界面或凭据文件更新的值会用于下一次请求。

`apiKeyEnv` 配置项只能保持为凭据引用 `TYPESAFE_API_KEY`，不能填写密钥值。不要把 key 写入 `cordis.patch.yml`、README 或提交到 Git。本插件不自行加载 `.env`，这些来源统一由 Harness 凭据服务处理。

### 验证安装

安装后可以先确认插件补丁已经进入 `web` profile：

```sh
dsh --profile web --dump-config | rg -n -C 2 skill-auto-load-typesafe
```

预期输出包含 `id: skill-auto-load-typesafe` 和 `name: dsh-skill-auto-load-typesafe`。随后启动或重启 `dsh web`，向 `standard` preset 的 Agent 发送一条包含明确任务的用户消息。若存在可见且适用的 skill，插件会把选中的完整指令加入同一次模型请求；没有 skill 达到阈值时不注入内容也属于正常结果。

从源码开发且愿意产生一次真实 TypeSafe API 用量时，还可以先验证凭据和服务连接：

```sh
TYPESAFE_API_KEY='<your-typesafe-api-key>' npm run test:live
```

## 插件配置

在 profile 的 `cordis.patch.yml` 中按插件行 ID 覆盖：

```yaml
- id: skill-auto-load-typesafe
  config:
    presetIds: [standard, ptc]
    apiKeyEnv: TYPESAFE_API_KEY
    baseURL: https://api.typesafe.ai
    model: jev-latest
    threshold: 0.75
    maxSkills: 3
    timeoutMs: 5000
    maxRetries: 0
    maxInputBytes: 65536
    maxInjectedBytes: 32768
    onSelectionError: continue
```

配置覆盖替换整个 `config`，不是深度合并。遗漏字段使用插件默认值。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `presetIds` | `[standard]` | 生效的 preset ID；`[]` 表示全部，包括无 preset 的 headless Agent |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | 固定凭据引用，标注 `credential-ref` 供配置界面发现；不能填入密钥值 |
| `baseURL` | `https://api.typesafe.ai` | SDK API root；正式服务要求 HTTPS，测试允许 loopback HTTP |
| `model` | `jev-latest` | TypeSafe 模型；需要稳定评估时使用账户支持的固定版本 |
| `threshold` | `0.75` | Noul 返回 yes 概率的入选阈值；不是独立的 confidence 字段 |
| `maxSkills` | `3` | 每次最多新增的技能数量，按概率降序、同概率按名称排序；已可见、不可用或超出正文预算的技能不占名额 |
| `timeoutMs` | `5000` | pre-step 自动加载操作的总时间预算，同时作为 SDK 单次请求超时 |
| `maxRetries` | `0` | SDK 最大重试次数；重试仍受总时间预算限制 |
| `maxInputBytes` | `65536` | 序列化的完整 TypeSafe 请求大小上限；超限明确报错，不截断用户输入或目录 |
| `maxInjectedBytes` | `32768` | 本次新增的 skill 正文 UTF-8 字节上限，包含资源定位信息 |
| `onSelectionError` | `continue` | 网络、响应解析或超时失败时继续原任务；`fail` 则拒绝本次处理 |

需要 `agents`、`skills`、`credentials`、`storageDomain` 服务。常规 base-backed profile 提供这些服务；自定义精简组合需要显式补齐。

## 运行行为

1. `agent/pre-step` 先等待其他监听器给出接受或拒绝决定，保留 `startsRequestSeries` 等字段。
2. 仅处理接受消息中的直接用户文本；工具续步、仅上下文消息、纯图片输入不触发选择。
3. 通过 `ctx.skills.snapshot({ cwd, scope: agent, signal })` 读取完整摘要，过滤禁止模型调用的 skills。不完整目录跳过选择并报告诊断。
4. 每个候选构造一个 Noul 问题，在一次 `systemOne()` 请求里提交；全部低于阈值时不加载任何 skill。
5. 校验网络响应中的问题 ID、类型和概率范围，重新加载并检查选中 skill 的调用权限。
6. 使用 Harness 的 `renderSkillContent()` 保留资源基址，完整附加到本次 `PreStepDecision.messages`。引用的其他文件由 Agent 按需读取。

显式 `/skill-name` 交由 Harness 自带 `tool-skill` 处理。已有显式加载消息不会重复注入。历史去重比较当前 `deriveMessages()` 中的完整正文；压缩后正文不再可见时允许重新加载，内容更新后也可以重新注入。预算不足时跳过整个 skill，不截断指令。

缺 key、认证失败、权限错误、无效 API 请求和本地配置错误明确失败；临时网络或响应错误按 `onSelectionError` 处理。审计写入和技能读取失败也会中止本次处理，不受 `continue` 降级影响。超时降级仅处理本次 deadline 引发的取消，不掩盖其他错误。用户取消和插件卸载始终取消请求，不作为正常降级吞掉。卸载等待在途操作结束，再关闭审计存储。审计写入不可取消，因此慢速存储仍可能使实际耗时超过 `timeoutMs`。

## 持久化与数据流

主模型看到的 skill 正文通过标准 `user/message` 持久化；来源为 `skill-auto-load-typesafe`，带有 skill 名称和审计请求 ID。插件不新增 Session 事件类型，因此移除插件后，标准 Session 读取器仍能重放这些消息。

TypeSafe 调用前，插件在 `ctx.storageDomain` 的 `skill_auto_load_typesafe` domain、`requests` 表写入 `started` 记录。记录包含 Session ID、用户消息 ID、endpoint 和实际 JSON 请求。完成后保存验证后的响应、选择名称、已准备的正文名称和跳过原因；失败保存分类。`selected` 包含所有达到阈值的候选，`loaded` 仅包含实际新增的技能，`skipped` 记录达到加载数量上限前检查过的跳过项。`completed` 表示插件已经准备好消息，不保证后续主模型请求成功。进程意外退出可能留下 `started`；插件不会据此自动重发。取消可能发生在正文准备或审计落盘后，最终是否提交以 Session 日志为准。

默认 JSON backend 将该 domain 放在 Harness 的 storage root 下，通常为 `$DSH_HOME/storages`。这些审计记录不随 Session 导出或 fork 复制。当前版本不自动清理审计历史，部署方需要管理保留周期和存储空间。

TypeSafe 会收到本次用户文本及可见 skill 的名称、完整 description、whenToUse；不发送 skill 正文、主模型完整历史或 API key 以外的 Harness 凭据。审计会保留这些任务文本和摘要。SDK body logging 被关闭，错误日志不输出服务返回的原始错误正文。

## 已知范围

- 选择仅依据本次接受的用户文本，不解析图片，也不自动读取历史来理解“继续刚才那个任务”。
- 单次请求有字节预算，尚无大目录分批或二阶段检索。
- `0.75` 是初始策略值，未根据你的任务集校准。现有 skill 工具和目录保留，主模型仍可补充加载遗漏项。
- 本插件只是加载指令，不授予新工具、权限或技能执行能力。
- 提供真实 key 的联网评估应单独进行；单元和集成测试不调用付费服务。

## 开发

```sh
git clone https://github.com/kibuniverse/dsh-skill-auto-load-typesafe.git
cd dsh-skill-auto-load-typesafe
npm ci
npm run typecheck
npm test
npm run build
```

适配版本见顶部[概要](#概要)；依赖通过 npm 安装，不依赖相邻 Harness 源码目录。Harness API 仍在演进，升级 peer dependencies 后应重新执行全部测试。

GitHub Actions 在 push 和 pull request 时使用 Node 22.19.0 执行 `npm ci`、类型检查、单元/集成测试和构建，不运行付费的 `test:live`。

测试使用真实 TypeSafe SDK、Cordis、skill registry、Session 投影和文件存储，HTTP 响应由测试提供。无需真实 key，也不产生 API 费用。尚未验证真实 TypeSafe 账户下的选择准确率或延迟。

设置环境变量 `TYPESAFE_API_KEY` 后，可显式执行 `npm run test:live`。它向 TypeSafe 发出一次真实选择请求，会产生 API 用量，只打印候选分数、选择结果和 usage。该 smoke 验证 SDK 与账户连接；不替代 Harness 中的完整会话测试。

## 发布

npm 暂存发布由推送到 `main`、`next`、`beta` 或 `rc` 分支自动触发。`release.yml` 先在 Node 22.19.0 和 Node 24 上完成类型检查、测试与构建，再使用 semantic-release 计算下一版本、生成发布说明和 Git 标签。npm 插件只准备版本与 tarball，本地 staging 插件使用锁定的 npm 11.20.0 执行 `npm stage publish`，确认返回的包名、版本和 stage ID 后创建 [GitHub Release](https://github.com/kibuniverse/dsh-skill-auto-load-typesafe/releases)。npm 包需维护者审核并通过 2FA 批准后才会公开；GitHub Release 会注明此流程，不代表 npm 审批已经完成。

`main` 暂存正式版本，批准后更新 npm 的 `latest` dist-tag；预发布分支与版本后缀、批准后的 dist-tag 一一对应：

| 分支 | 版本示例 | npm dist-tag |
|---|---|---|
| `next` | `0.0.6-next.1` | `next` |
| `beta` | `0.0.6-beta.1` | `beta` |
| `rc` | `0.0.6-rc.1` | `rc` |

创建对应分支并推送包含 `fix:`、`feat:` 或破坏性变更的 Conventional Commit，即可发布或递增该通道的预发布版本。例如，从最新 `main` 创建 `rc` 分支后推送 `fix: ...`，会发布类似 `0.0.6-rc.1` 的版本；后续符合发布条件的提交会递增为 `0.0.6-rc.2`。准备正式发布时，将预发布分支合并回 `main`，由 `main` 发布正式版本。三个预发布分支只用于对应通道，普通功能分支不会触发发包。

推荐使用 **Squash and merge**，将 PR 标题写成 Conventional Commits 格式，并确认最终 squash commit 包含需要保留的破坏性变更说明：

| 提交示例 | 自动版本变化 |
|---|---|
| `fix: 修复技能加载失败` | 补丁版本，例如 `0.0.5` → `0.0.6` |
| `perf: 优化选择器开销` | 补丁版本 |
| `feat: 支持新的选择模式` | 次版本，例如 `0.0.5` → `0.1.0` |
| `feat!: 修改配置格式` 或正文包含 `BREAKING CHANGE:` | 主版本，例如 `0.0.5` → `1.0.0` |
| `docs:`、`test:`、`ci:`、`chore:` 等无破坏性变更的提交 | 不发布，累计到后续功能或修复版本 |

多个提交取最高级别的版本变化。直接推送到 `main` 也会触发相同流程。无需手动升版本、打标签或创建 Release；每个 npm 暂存包均需人工审批。

版本以 `v*` Git 标签为基准；semantic-release 在 CI 内更新待发布包的版本，不把版本号提交回 `main`。因此仓库中的 `package.json` / 锁文件版本可保留开发基线，不代表 npm 最新版本。发布记录和变更说明以 GitHub Releases 为准。

首次启用时，在 npm 包的 **Settings → Trusted Publisher** 添加 GitHub Actions：

- Organization or user：`kibuniverse`
- Repository：`dsh-skill-auto-load-typesafe`
- Workflow filename：`release.yml`
- Environment：留空
- Allowed action：**允许 `npm stage publish`**；本流程不需要直接 `npm publish` 权限

工作流使用 GitHub 自动提供的 `GITHUB_TOKEN` 创建标签与 Release，通过 npm Trusted Publishing（OIDC）提交暂存包，不需要个人 GitHub token 或 `NPM_TOKEN`。npm 的 **Require two-factor authentication and disallow tokens** 设置不影响 OIDC 暂存。审批需要维护者本人登录并完成 2FA，不能使用工作流 OIDC 自动批准。

常规开发到发布流程：

1. 在开发分支修改代码和文档，运行 `npm run typecheck`、`npm test` 和 `npm run build`。
2. 需要预发布时，将改动合并到 `next`、`beta` 或 `rc`；需要正式发布时合并到 `main`。
3. `Release` 工作流自动检查并暂存对应通道的包；没有需要发布的提交时正常结束。成功暂存的 stage ID 和目标 dist-tag 显示在 Actions 运行摘要中。
4. 在 npmjs.com 的 Staged Packages 中核对版本并通过 2FA 批准，或用支持 staging 的 npm CLI 执行以下命令：

```sh
npm stage list dsh-skill-auto-load-typesafe
npm stage view <stage-id>
npm stage approve <stage-id>
npm view dsh-skill-auto-load-typesafe dist-tags --json
```

发布认证需要 GitHub Actions 环境，本地测试不执行真实暂存或审批。历史标签应保留，不补发或删除；需要重新触发发布时使用新的发布型提交生成下一版本。

测试或 OIDC 环境检查在创建标签前失败时，可修正配置后重跑，或在 Actions 中对发布分支手动运行 `Release`。semantic-release 会在上传前创建标签，实际认证或上传失败仍可能留下标签；若标签已经存在，重跑不会补发同一版本。此时先核对 staging queue、npm 版本、Git 标签和 GitHub Release：包已暂存则审批已有 stage；没有上传则修正问题后用新的 `fix:` 提交触发下一 patch 版本。不要盲目删除标签或重复上传。若 GitHub ruleset 限制创建 `v*` 标签，需要为发布机器人配置相应权限。

发布流程参考：[semantic-release GitHub Actions](https://semantic-release.org/recipes/ci-configurations/github-actions/)、[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、[npm Staged Publishing](https://docs.npmjs.com/staged-publishing/)。

参考：[TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)、[Noul](https://docs.typesafe.ai/primitives/noul)、[Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion)。
