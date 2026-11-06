# cake

在终端里工作的 TypeScript 编程 agent：读写代码、执行命令、检索代码库、派出子 agent，并能接入任意 MCP server。

对标 Claude Code / Aider / Gemini CLI，强调三件事：

- **可控**：四种权限模式 + allow/deny 规则 + 危险命令识别，默认不会替你删库。
- **可换**：DeepSeek / Anthropic / OpenAI 统一抽象，换 provider 或本地兼容端点只改配置。
- **可扩展**：内置工具之外，MCP server 的工具会被自动发现并暴露给模型。

> 状态：M0–M7 开发完成（内核、工具、权限、会话、RAG、编排、MCP、分发打磨）。npm 发布尚待确定包名与许可。

## 要求

- Node.js **>= 22.5**（会话与索引使用内置 `node:sqlite`）
- 一个模型 API key（默认 DeepSeek）

## 安装

```bash
# 全局安装（包发布后）
npm install -g cake

# 或直接运行
npx cake --help

# 从源码
pnpm install
pnpm build
node dist/cli.js --help
```

## 快速开始

```bash
# 交互式对话
cake

# 单次任务（headless，适合脚本）
cake "给 src/utils.ts 里的 parseDate 补一个单元测试"

# 自动批准所有工具调用（谨慎）
cake -y "把 README 里的命令跑一遍，修掉失败项"

# 只读分析
cake --permission-mode plan "解释这个仓库的鉴权流程"
```

首次运行前设置密钥：

```bash
# 默认 provider 是 DeepSeek（deepseek-chat）
export DEEPSEEK_API_KEY=sk-...

# 想用 Anthropic / OpenAI 时再设置对应密钥并加 --provider
# export ANTHROPIC_API_KEY=sk-ant-...
# export OPENAI_API_KEY=sk-...

# 需要 @codebase 语义检索时还需要（嵌入模型目前只来自 OpenAI）
export OPENAI_API_KEY=sk-...
```

不确定环境哪里没配好？先跑诊断：

```bash
cake --doctor
```

`--doctor` 会检查 Node 版本、provider 密钥、全局/项目配置、权限规则、MCP 配置、会话库与代码索引，不发起任何模型请求。

## 常用参数

| 参数                           | 作用                                        |
| ------------------------------ | ------------------------------------------- |
| `cake "<prompt>"` / `-p`       | 非交互执行，流式输出后退出                  |
| `-y, --yes`                    | yolo 模式，所有工具调用免审批               |
| `--permission-mode <m>`        | `plan` / `default` / `acceptEdits` / `yolo` |
| `--provider <id>`              | `deepseek`（默认）/ `anthropic` / `openai`  |
| `-m, --model <id>`             | 覆盖默认模型                                |
| `-c, --continue`               | 续跑当前工作区最近的会话                    |
| `--resume <id>`                | 续跑指定会话                                |
| `--doctor`                     | 环境与配置诊断                              |
| `-v, --version` / `-h, --help` | 版本 / 帮助                                 |

交互模式下的输入：

- `@path/to/file` 把文件内容附进本条消息
- `@codebase` 先做一次语义检索，把相关代码块附进消息
- `/help` `/clear` `/fork` `/export [file]` `/model <id>` `/cost` `/exit`

## 权限模型

| 模式          | 行为                                              |
| ------------- | ------------------------------------------------- |
| `plan`        | 只读：读文件、搜索；禁止写文件、shell、git 写操作 |
| `default`     | 读操作放行；写文件与 shell 需要逐次审批           |
| `acceptEdits` | 写文件放行；shell 仍需审批                        |
| `yolo`        | 全部放行                                          |

项目级规则写在 `.cake/settings.json`（全局为 `~/.cake/settings.json`，两处会合并）：

```json
{
  "permissions": {
    "allow": ["bash(npm test*)", "bash(pnpm lint*)"],
    "deny": ["bash(rm -rf *)", "read(.env)"]
  }
}
```

规则语法为 `tool` 或 `tool(pattern)`，`*`/`?` 通配；deny 优先于 allow。危险命令（如 `rm -rf`、`git push --force`、`git reset --hard`）即使命中 allow 也会二次确认。

## 配置

配置按 `~/.cake/config.json` → `./.cake/config.json` → 环境变量 的顺序层叠：

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "providers": {
    "deepseek": { "apiKey": "...", "model": "deepseek-chat" },
    "anthropic": { "apiKey": "...", "model": "claude-sonnet-4-5" },
    "openai": { "apiKey": "...", "baseURL": "https://api.openai.com/v1" }
  }
}
```

支持的环境变量：`DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`CAKE_PROVIDER`、`CAKE_MODEL`、`DEEPSEEK_BASE_URL`、`ANTHROPIC_BASE_URL`、`OPENAI_BASE_URL`。密钥优先级：显式配置 > 环境变量 > 配置文件。

> DeepSeek 走 OpenAI 兼容的 chat completions 协议（默认模型 `deepseek-chat`，支持工具调用）；`deepseek-reasoner` 不支持工具调用，agent 场景请用 `deepseek-chat`。接入本地或第三方兼容端点时，把 `providers.deepseek.baseURL` 或 `DEEPSEEK_BASE_URL` 指向对应地址即可。

## MCP

在 `~/.cake/mcp.json`（全局）或 `.cake/mcp.json`（项目，同名覆盖全局）里声明 server：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/work/repo"]
    },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
      "permission": "read"
    }
  }
}
```

- 支持 `stdio`（`command`/`args`/`env`/`cwd`）与 Streamable HTTP（`url`/`headers`）
- 配置值里的 `${VAR}` 会用环境变量展开，缺变量会直接报错
- 工具以 `mcp__<server>__<tool>` 暴露；server 标注 `readOnlyHint` 的工具自动归为只读，可用 `permission` 强制覆盖
- 每个 server 默认最多直接暴露 24 个工具（`maxTools` 可调），超出的收进 `mcp__<server>__more`（`action=list` / `action=call`），避免提示词被工具目录淹没
- 某个 server 连接失败只会降级为 `[mcp] ... unavailable` 警告，不影响其他工具

完整字段与示例见 [docs/mcp.md](docs/mcp.md)。

## 代码库检索（RAG）

```bash
cake "@codebase 这个仓库在哪里处理 token 刷新？"
```

- tree-sitter wasm 按函数/类切块，嵌入写入 `.cake/index/code.db`
- 首次检索时自动建索引，之后按 mtime + 内容哈希增量更新
- 语义向量 + 词法匹配混合打分；改动过的文件在检索前会先刷新
- 词法候选走 SQLite FTS5（`node:sqlite` 自带），存的是分词后的标识片段而不是源码原文，所以 `alpha` 也能命中 `alphaHandler`；2 万块的库上候选阶段从 298ms 降到 16ms，排序结果与全表扫描一致
- 没有 `OPENAI_API_KEY` 时自动退化为纯词法检索
- 本次真正进入提示词的代码块会随 note 一起报出：CLI 打印 `路径:起始行`，桌面版渲染成命中卡片（路径 · 行号区间 · 命中方式 · 分数），点一张就把 `@path` 放进输入框

## 子 agent

主 agent 可以调用 `agent` 工具派生子 agent：

- `explore` / `plan`：工具被裁剪为只读，适合在大仓库里扫结果、做方案
- `general`：完整工具集
- 子 agent 有独立上下文，只回传结论摘要；token 与成本会汇总进父会话统计
- 同一步里的多个 `agent` 调用并行执行；子 agent 不能再嵌套派生子 agent

## 图片输入

- 上限只写在 `src/core/images.ts` 一处：一轮最多 4 张，单张解码后不超过 3 MB，格式限 PNG / JPEG / GIF / WebP
- 桌面端可以粘贴、拖入，或点 Attach 选文件；图片先作为附件停在输入框里，发送时才随文字走 IPC。没有先说要看什么（正文为空）时 Send 保持不可用
- 模型能不能读图由 provider 注册表判定：非视觉模型下 Attach 直接禁用（提示写在按钮 title 上），粘贴和拖入也不会进入这一轮；真要发的时候内核再拒绝一次
- CLI 和桌面都能写 `@path/to/shot.png`：命中的图片按图片附加，而不是按文本展开。同一张图既粘贴又 `@` 只发一次
- 拒绝发生在花钱之前：数量或大小超限、模型读不了图，都在发出请求之前抛错
- 上下文占比把每张图按供应商给的单张上限估算（1600 token），并在界面上标明是估算
- 渲染端不 import 内核运行时代码，接受类型在 `web/src/attachments.ts` 里另写一份；一条测试比较这两份表，多出来的格式想进来必须同时改两处

## 会话与观测

- 会话历史存 `.cake/sessions/cake.db`，`cake -c` 续跑最近一次
- 每一轮的开销按行存进 `.cake/sessions/cake.db`（哪个模型、主流程还是哪个子 agent、有没有费率），桌面端 Cost 面板、CLI `/cost` 和顶部成本标签读同一份数据；没有费率的模型只记 token 并显示"无价格 / no price set"，绝不显示 `$0.0000`
- 历史接近上下文窗口时自动压缩（保留摘要 + 近期消息）
- `/fork`（桌面版是会话行上的分叉按钮）把当前会话的消息和计划复制成一个新会话：开销从零开始（父会话的 token/成本不会跟着走），并记下 `parent_id` 血缘；删掉父会话，分叉照样能读；一轮正在跑的时候拒绝分叉
- `/export [file]` 把整段对话写成 Markdown，默认落在 `.cake/exports/<workspace>-<id>.md`（桌面版可以把相对路径指到 workspace 里面任意位置，越界的直接拒绝）。导出的是模型真正看到的展开文本（`@file` 的内容也在里面），工具结果拆掉信封只留负载，负载里自带的 ``` 用加长围栏保住原文
- 会话里发过的图片跟着导出一起落盘：写在 Markdown 同目录的 `assets/` 下，文件名由图片字节算出（sha256 前 12 位 + 原格式后缀），所以同一张图被两轮用到也只写一份，Markdown 里两条链接指向同一个文件；`/export` 的输出和桌面端的导出提示都会点名这个文件夹
- `CAKE_TRACE=1 cake "..."` 会把工具调用/结果/错误写进 `.cake/logs/run-*.jsonl`（本地文件，默认关闭，不上传任何数据）

## 桌面端界面

Electron 窗口是三栏布局：左侧会话栏（搜索 / 重命名 / 删除会话、切换工作区），中间对话区（审批卡、工具卡片与 diff、复制消息、跳转最新），右侧 inspector（Changes / Plan / Context / Cost / Files）。

- 输入框工具栏整合 provider/model 切换、权限模式与上下文占比（蛋糕切片仪表），模型与模式菜单向上展开
- 顶部保留命令面板、夜间 / 羊皮纸主题（默认羊皮纸浅色，选择会记住）与 inspector 开关
- `Ctrl K` 命令面板，`Ctrl N` 新会话，`Ctrl B` 折叠会话栏，`Ctrl J` 折叠 inspector
- 输入框支持 `/` 命令（`/help`、`/new`、`/clear`、`/fork`、`/export [file]`、`/model`、`/mode`、`/files`、`/mcp`、`/doctor`、`/cost`）和 `@` 文件补全
- 输入框工具条上的 Attach 只管图片：粘贴 / 拖入 / 选文件都进同一暂存列表，每条一个缩略图和"类型 · 大小"标签，可以单独移除；被拒的部分走同一条错误行，说清原因（格式、超出单张大小、一轮名额已满、这张已经附过了）。回合卡片把自己那轮发的图排在文字下面，alt 留空、由列表名说明这是什么
- inspector 的 Diagnostics 不只报告问题：每条警告 / 失败都带一个可执行动作——粘贴 provider 密钥（写入 `~/.cake/config.json` 并立刻重建 provider 注册表与 embedding）、重建代码索引、重连 MCP、打开对应配置文件（文件缺失时先写入合法空模板）、在文件管理器中定位会话库或索引库；动作完成后自动重跑检查。CLI 的 `--doctor` 仍只读，不改动任何东西
- inspector 的 Cost 把一次会话的开销拆开列：按轮次（可展开到每个模型一行，子 agent 的开销挂在引起它的那一轮里）、按模型、按工作（主流程 / 某个子 agent），最后给出整个工作区跨会话的合计。没有费率的模型显示"no price set"或"$X + unpriced"，同一规则也用在顶栏成本标签、会话栏和运行读数上；费率卡片里点"Set rate"会把该模型的 pattern 填进编辑表单
- 窄窗口下会话栏与 inspector 变为浮层，一次只显示一个

## 打包二进制

产物输出到 `release/`（已 gitignore）：

| 命令                       | 产物                                                              | 说明                                                    |
| -------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| `npm run cli:binary`       | `release/cake.exe`                                                | CLI 单文件（Node SEA），内含所有依赖与 tree-sitter wasm |
| `npm run desktop:dist`     | `release/cake-0.1.0-setup.exe`、`release/cake-0.1.0-portable.exe` | Electron 安装包 / 便携版                                |
| `npm run desktop:dist:dir` | `release/win-unpacked/`                                           | 未打包目录，便于本地验证                                |

CLI 二进制需要 Node >= 26.9 作为 SEA 基底（Ink 8 的 top-level await 要求 ESM 入口），本机 Node 版本较低时用环境变量指定：

```bash
CAKE_SEA_NODE=/path/to/node26/node.exe npm run cli:binary
```

SEA 构建会把 wasm 资产解压到 `~/.cake/runtime/<version>/wasm`，通过 `CAKE_WASM_DIR` 交给 tree-sitter。网络受限时给 electron-builder 配镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run desktop:dist
```

安装包未签名，Windows SmartScreen 会提示；正式分发前需配置证书。

## 开发

```bash
pnpm install
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome check
pnpm build        # tsup → dist/cli.js
pnpm cake --help  # 用 tsx 直接跑源码
```

目录结构：

```
src/
├── cli/            Ink 界面、slash 命令
├── core/           agent 循环、事件、上下文压缩
├── providers/      provider 抽象与注册表
├── tools/          内置工具（read/write/edit/glob/grep/bash/git/task）
├── permissions/    权限模式、规则、危险操作识别
├── rag/            tree-sitter 分块、嵌入、索引、混合检索
├── orchestration/  子 agent
├── mcp/            MCP 客户端、配置与工具适配
├── session/        SQLite 会话存储
├── diagnostics/    cake --doctor
└── observability/  本地 trace
```

## License

Private / TBD.
