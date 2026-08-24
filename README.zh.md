# dsh-lark-bridge

> 一个原生的 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-V3)（dsh）插件，把 dsh 编码智能体接入**飞书 / Lark 群聊**——*一个群，一个项目文件夹*。

[English README](./README.md)

在飞书里发一条消息，一个真正的 dsh 智能体（带自己的工具、自己的项目目录、自己的持久对话）就在群里回你。每个群聊都是一个隔离的工作区，所以团队可以并行跑多个项目，一个群一个。

---

## 它能做什么

- **飞书 ⇄ dsh 智能体。** 飞书消息通过宿主的 `agents` 服务驱动一个活着的 dsh 智能体；回复以「实时更新的飞书消息」流式返回。
- **一个群，一个项目文件夹。** 每个 chat id 映射到一个固定目录（`<workspaceRoot>/<chatId>`），首次使用时创建。不同群互不干扰彼此的文件。
- **按群持久会话。** 一个群的对话在重启后依然保留（按策略指纹门控的「恢复或新建」，`/new` 真正清空）。
- **看图 / 收文件。** 图片和文件直接发给机器人即可——bridge 下载到本群工作区的 `.attachments/` 目录并把路径交给智能体（图片用 `read_image` 查看）。限制：每条消息最多 5 个附件，图片 ≤10MB、文件 ≤20MB，超出会被明确拒绝；文件名自动消毒，7 天后自动清理。
- **零配置启动。** 首次启动若没有凭证，插件会自动跑二维码注册向导——用飞书 App 一扫就自动连上，不用去开放平台后台一步步翻。
- **斜杠命令。** `/help`、`/new`、`/where`、`/model`、`/whoami` 在本群本地管理；owner 可用 `/allow`、`/disallow` 在群内直接授权/撤销。

## 一张图看懂架构

```
①  飞书开放平台                    ← 在这里注册机器人（自动二维码向导帮你搞定）
        │  给你: app_id + app_secret
        ▼
②  dsh-lark-bridge（本插件）        ← 拿着钥匙，主动连飞书长连接，
        │                             把每条消息变成一个智能体回合
        ▼
③  dsh 宿主（DeepSeek Harness）     ← 加载本插件，提供 `agents` 服务
```

机器人**注册完全在飞书这一侧**，跟 dsh 无关。dsh 只负责「加载本插件」；插件再用 WebSocket **长连接**主动连到飞书（所以不需要公网 IP、也不需要回调地址）。

---

## 环境要求

- 一个能用 `dsh web` 启动的 **DeepSeek Harness（dsh）** 代码库。
- **Node.js** `^22.19.0 || >=24.0.0`。
- 一个 **DeepSeek API key**（设 `DEEPSEEK_API_KEY`，或配到 dsh 的凭证里）。
- 一个 **飞书账号** 用来扫码（向导会替你创建应用）。

## 安装

### 方式一：dsh 官方命令（已装好 dsh 时推荐）

```bash
# 从你的 dsh 代码库目录执行；`link:` 指向本项目目录
dsh plugin --profile web add link:/path/to/dsh-lark-bridge
```

`dsh plugin` 会在 profile 目录里执行 `pnpm add`，并**自动把声明了 `dsh.bundle` 的包加进 `dsh.profile.bundles`**——装完即注册，重启后自动加载，无需 `--patch`、无需手动改配置。卸载/升级同样是官方命令：`dsh plugin --profile web remove dsh-lark-bridge` / `dsh plugin --profile web update dsh-lark-bridge`。

### 方式二：一键脚本（推荐）

```bash
git clone https://github.com/bihangchi9-creator/dsh-lark-bridge.git
cd dsh-lark-bridge
pnpm setup            # macOS / Linux（脚本: scripts/setup.sh）
pnpm setup:win        # Windows（脚本: scripts/setup.ps1）
```

脚本会：预检 Node 版本 → 构建插件 → 把插件链接进 dsh profile → **注册为 bundle**（`dsh` 可用时内部直接走方式一的官方命令）。
之后直接启动即可，**不需要 `--patch` 参数**：

```bash
# macOS / Linux
DSH_PERMISSION_MODE=danger-full-access dsh web

# Windows PowerShell
$env:DSH_PERMISSION_MODE = "danger-full-access"; dsh web
```

> 换 profile：`DSH_PROFILE=headless pnpm setup`；自定义 dsh 目录：`DSH_HOME=/path/.dsh pnpm setup`（Windows 同样支持这两个环境变量）。

### 方式三：手动安装（源码模式）

由于 dsh 的公开 npm 依赖图还不完整，建议以「源码模式」和你的 dsh 代码库放在一起安装。

```bash
# 1. 克隆到 dsh 代码库旁边，安装并构建
git clone https://github.com/bihangchi9-creator/dsh-lark-bridge.git
cd dsh-lark-bridge
pnpm install
pnpm build            # 把 src/ 编译到 lib/
```

然后把它注册成 dsh 的一个 **bundle**（装进 profile 即自动加载，无需 `--patch`）：

```bash
# 2. 链接进 profile 的 node_modules（bundle 解析锚点）
#    macOS / Linux：
mkdir -p ~/.dsh/profiles/web/node_modules
ln -s "$(pwd)" ~/.dsh/profiles/web/node_modules/dsh-lark-bridge
#    Windows PowerShell（目录联接，无需管理员权限）：
#    New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-lark-bridge" -Target (Get-Location).Path

# 3. 在 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 末尾加上包名：
#    "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-lark-bridge"]
```

启动（**裸命令即可，插件随 bundle 自动加载**）：

```bash
# 在你的 dsh 代码库里
DSH_PERMISSION_MODE=danger-full-access dsh web
```

> `DSH_PERMISSION_MODE=danger-full-access` 会把智能体的审批策略设为 `never`。这是必需的，因为飞书用户没法点本地的审批弹窗。**请只在你信任的环境里使用。**

## 平台差异速查（Windows vs macOS/Linux）

| 事项 | macOS / Linux | Windows |
|---|---|---|
| 一键安装 | `pnpm setup`（`scripts/setup.sh`） | `pnpm setup:win`（`scripts/setup.ps1`） |
| dsh 主目录 | `~/.dsh`（即 `$HOME/.dsh`） | `%USERPROFILE%\.dsh` |
| 目录链接 | `ln -s`（符号链接） | `New-Item -ItemType Junction`（目录联接，**无需管理员权限**） |
| 环境变量写法 | `DSH_PERMISSION_MODE=danger-full-access dsh web` | PowerShell：`$env:DSH_PERMISSION_MODE="danger-full-access"; dsh web`；cmd：`set DSH_PERMISSION_MODE=danger-full-access && dsh web` |
| 注册链接文件 | `~/.dsh-lark-bridge/register-url.txt` | `%USERPROFILE%\.dsh-lark-bridge\register-url.txt` |
| 后台常驻 | `launchd`（macOS）/ `systemd`（Linux） | 任务计划程序（`schtasks`） |
| 扫码注册 / 构建 / 聊天命令 | 全平台一致 | 同左 |

> 两个安装脚本行为完全一致且幂等：预检 → 构建 → 链接 → 注册 bundle。

## 首次运行：注册你的机器人

**每个人都要注册自己的飞书机器人**——你不能把 `app_secret` 给别人，那等于把机器人的控制权交出去。

首次启动、没有凭证时，插件会在终端打印**二维码**（后台运行时还会把链接写到 `~/.dsh-lark-bridge/register-url.txt`）。步骤：

1. 打开**飞书手机 App**，扫描二维码。
2. 在手机上确认创建一个自建应用。
3. 插件收到凭证，存到 `~/.dsh-lark-bridge/credentials.json`，并**自动连上飞书**。
4. 把机器人拉进一个群（或私聊它），开始对话。

想手动做 / 重新注册 / 换账号？跑独立向导：

```bash
pnpm register           # 或: npx dsh-lark-register
```

已经有凭证了？直接用环境变量跳过向导：

```bash
export LARK_APP_ID=cli_xxx
export LARK_APP_SECRET=yyy
export LARK_TENANT=feishu      # 国际版 larksuite.com 用 `lark`
```

---

## 在群里怎么用

| 命令 | 作用 |
|---|---|
| *（任意文字）* | 发给本群智能体的提示词 |
| `/help` | 显示帮助 |
| `/new` | 开一个全新会话（清空本群上下文） |
| `/where` | 显示本群的项目目录 |
| `/model [名称]` | 查看或切换本群使用的模型 |
| `/whoami` | 显示你的用户身份和本群的授权状态 |
| `/allow` | （仅 owner，群聊）在本群授权，允许成员使用机器人 |
| `/disallow` | （仅 owner，群聊）撤销本群授权 |

在**群聊**里，要 `@` 机器人才会触发（除非关掉了 mention 要求）。在**私聊**里，直接发消息即可。

## 配置

每个字段都可以来自插件 `config:` 块 **或** 环境变量（推荐用环境变量，更省事）。

| 配置项 | 环境变量 | 默认值 | 含义 |
|---|---|---|---|
| `appId` | `LARK_APP_ID` | — | 飞书 app id（`cli_...`） |
| `appSecret` | `LARK_APP_SECRET` | — | 飞书 app secret |
| `tenant` | `LARK_TENANT` | `feishu` | `feishu`(feishu.cn) 或 `lark`(larksuite.com) |
| `provider` | `DSH_LARK_PROVIDER` | dsh 默认 | LLM 提供方 |
| `model` | `DSH_LARK_MODEL` | dsh 默认 | 创建智能体用的模型 |
| `workspaceRoot` | `DSH_LARK_WORKSPACE_ROOT` | `~/dsh-lark-workspaces` | 按群文件夹的根目录 |
| `allowDm` | `DSH_LARK_ALLOW_DM` | `true` | 是否响应私聊 |
| `requireMention` | `DSH_LARK_REQUIRE_MENTION` | `true` | 群里是否必须 `@` 才触发 |
| `allowedChats` | `DSH_LARK_ALLOWED_CHATS` | `[]` | 允许使用机器人的群 chatId（逗号分隔）。**空 = 任何群都不允许（fail-closed）** |
| `allowedUsers` | `DSH_LARK_ALLOWED_USERS` | `[]` | 允许私聊使用机器人的用户 open_id（逗号分隔）。**空 = 私聊只允许 owner** |

凭证读取顺序：内联 config → 环境变量 → 注册向导写的文件。

## 访问控制（安全模型）

机器人的**安全边界 = "谁能给机器人发消息"**：每条消息都会变成一次宿主机权限的智能体回合，所以默认严格拒绝：

- **owner 永远放行**：注册时扫码的那个人就是 owner（open_id 存于 `credentials.json`）；老安装会在启动时通过应用信息 API 自动回填。
- **群聊**：只有 chatId 在 `DSH_LARK_ALLOWED_CHATS` 里的群可以用。
- **私聊**：只有 open_id 在 `DSH_LARK_ALLOWED_USERS` 里的用户可以用（owner 除外）。
- **fail-closed**：owner 未知且白名单为空时，**所有消息都被拒绝**，拒绝回复里会带上 chatId 方便你配置。

配置示例：

```bash
# 允许群 oc_xxx1、oc_xxx2，允许用户 ou_friend 私聊
export DSH_LARK_ALLOWED_CHATS="oc_xxx1,oc_xxx2"
export DSH_LARK_ALLOWED_USERS="ou_friend"
```

> 需要 `application-info` 权限才能运行时解析 owner；注册向导直接捕获 open_id，通常不需要额外配置。**强烈建议任何暴露给团队以外的人使用的部署都配置白名单。**

## 权限档位（爆炸半径）

即使消息通过了授权门，agent 能碰到什么仍然按档位收敛（`DSH_LARK_ACCESS_MODE`，默认 `workspace`）：

| 档位 | preset | agent 能做什么 |
|---|---|---|
| `read-only` | `lark-readonly` | 只能搜索/读取文件——不能写、不能执行、不能联网 |
| `workspace`（默认） | `lark-workspace` | 读写/编辑文件；**没有 shell、没有网络、没有子代理**（不可执行任意代码） |
| `full` | 部署默认 | 宿主提供的全部能力（含 bash、网络、子代理） |

preset 是 dsh 的"工具集组合"概念：宿主沙箱对所有 preset 一致，档位的可执行差异 = **哪些工具存在**。工作区档把攻击面的皇冠（任意代码执行 + 网络出口 + 委托）整个拿掉。

安装 preset（复制到 dsh 的 harness-home 用户根目录即可，发现无缓存）：

```bash
# 把项目里的 presets/ 装进 dsh 的 preset 根
mkdir -p ~/.dsh/.agent-presets
cp -r presets/lark-workspace presets/lark-readonly ~/.dsh/.agent-presets/
```

> 进一步的收敛（宿主级）：dsh 的权限预设 `workspace-write`（沙箱=工作区内写 + 越界需审批）可以让 fs 写入硬性限制在工作区内——但该模式对远程用户是"越界即拒绝"（审批弹窗无人点），且会改变 bash 行为，启用前需在目标部署验证。当前插件层档位已经移除 bash/web/子代理，是收益/风险比最高的部分。

---

## 与 lark-cli 搭配使用

如果你已经在用 [`lark-cli`](https://github.com/larksuite/cli) / Lark 系列 skill 来操作飞书（文档、表格、IM、日历……），本插件正好和它互补：继续用 `lark-cli` 做结构化的飞书操作，让 **dsh-lark-bridge** 做那个「住在群聊里的对话式编码智能体」。**非常欢迎把两者结合起来用**——比如在群里让智能体起草内容，再用 `lark-cli` 的 skill 把它推进飞书文档。

## 排障

- **机器人不吭声 /「(no output)」** —— 确认模型能被解析（dsh 的默认模型服务要配好，或设 `DSH_LARK_MODEL`）。
- **「missing Feishu credentials」** —— 向导没走完；重新跑 `pnpm register`，或导出 `LARK_APP_ID` / `LARK_APP_SECRET`。
- **看不到二维码（dsh 在后台跑）** —— 用浏览器打开 `~/.dsh-lark-bridge/register-url.txt` 里的链接。
- **群消息被忽略** —— 需要 `@` 机器人，或设 `DSH_LARK_REQUIRE_MENTION=false`。

## 致谢

`dsh-lark-bridge` 是对 [zarazhangrui](https://github.com/zarazhangrui) 的 [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)（最初名为 `feishu-claude-code-bridge`）的二创，经由 [trae-to-lark](https://github.com/bihangchi9-creator/trae-to-lark) 演化而来。本项目是一个 dsh 原生插件的从零重写。所有原始工作仍遵循其 MIT 许可；完整的版权链见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。

## 许可

[MIT](./LICENSE)
