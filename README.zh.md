# dsh-lark-bridge

> 一个原生的 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-V3)（dsh）插件，把 dsh 编码智能体接入**飞书 / Lark 群聊**——*一个群，一个项目文件夹*。

[English README](./README.md)

在飞书里发一条消息，一个真正的 dsh 智能体（带自己的工具、自己的项目目录、自己的持久对话）就在群里回你。每个群聊都是一个隔离的工作区，所以团队可以并行跑多个项目，一个群一个。

---

## 它能做什么

- **飞书 ⇄ dsh 智能体。** 飞书消息通过宿主的 `agents` 服务驱动一个活着的 dsh 智能体；回复以「实时更新的飞书消息」流式返回。
- **一个群，一个项目文件夹。** 每个 chat id 映射到一个固定目录（`<workspaceRoot>/<chatId>`），首次使用时创建。不同群互不干扰彼此的文件。
- **按群持久会话。** 一个群的对话在重启后依然保留（对固定的按群 session id 做「恢复或新建」）。
- **零配置启动。** 首次启动若没有凭证，插件会自动跑二维码注册向导——用飞书 App 一扫就自动连上，不用去开放平台后台一步步翻。
- **斜杠命令。** `/help`、`/new`、`/where`、`/model` 在本群本地管理。

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

由于 dsh 的公开 npm 依赖图还不完整，建议以「源码模式」和你的 dsh 代码库放在一起安装。

```bash
# 1. 克隆到 dsh 代码库旁边
git clone https://github.com/bihangchi9-creator/dsh-lark-bridge.git
cd dsh-lark-bridge

# 2. 安装并构建
pnpm install
pnpm build            # 把 src/ 编译到 lib/
```

然后让 dsh 加载它。把插件行加进你启动的 profile（或直接用自带的 patch）：

```yaml
# cordis.patch.yml （本包已自带）
- insert:
    - id: lark-bridge
      name: dsh-lark-bridge
      inject: [agents, sessions, agentPresets, agentDefaultModel]
```

带着 patch 启动 dsh：

```bash
# 在你的 dsh 代码库里
DSH_PERMISSION_MODE=danger-full-access \
  dsh web --patch /path/to/dsh-lark-bridge/cordis.patch.yml
```

> `DSH_PERMISSION_MODE=danger-full-access` 会把智能体的审批策略设为 `never`。这是必需的，因为飞书用户没法点本地的审批弹窗。**请只在你信任的环境里使用。**

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

凭证读取顺序：内联 config → 环境变量 → 注册向导写的文件。

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
