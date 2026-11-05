# cake

在终端里工作的 TypeScript 编程 agent：读写代码、执行命令、检索代码库、派出子 agent，并能接入任意 MCP server。

对标 Claude Code / Aider / Gemini CLI，强调三件事：

- **可控**：四种权限模式 + allow/deny 规则 + 危险命令识别，默认不会替你删库。
- **可换**：Anthropic / OpenAI 统一抽象，换 provider 或本地兼容端点只改配置。
- **可扩展**：内置工具之外，MCP server 的工具会被自动发现并暴露给模型。

> 状态：M0–M7 开发完成（内核、工具、权限、会话、RAG、编排、MCP、分发打磨）。npm 发布尚待确定包名与许可。

## 要求

- Node.js **>= 22.5**（会话与索引使用内置 `node:sqlite`）
- 一个模型 API key（默认 Anthropic）

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
export ANTHROPIC_API_KEY=sk-ant-...
# 需要 @codebase 语义检索时还需要
export OPENAI_API_KEY=sk-...
```

不确定环境哪里没配好？先跑诊断：

```bash
cake --doctor
```

`--doctor` 会检查 Node 版本、provider 密钥、全局/项目配置、权限规则、MCP 配置、会话库与代码索引，不发起任何模型请求。

## 常用参数

| 参数 | 作用 |
|---|---|
| `cake "<prompt>"` / `-p` | 非交互执行，流式输出后退出 |
| `-y, --yes` | yolo 模式，所有工具调用免审批 |
| `--permission-mode <m>` | `plan` / `default` / `acceptEdits` / `yolo` |
| `--provider <id>` | `anthropic` / `openai` |
| `-m, --model <id>` | 覆盖默认模型 |
| `-c, --continue` | 续跑当前工作区最近的会话 |
| `--resume <id>` | 续跑指定会话 |
| `--doctor` | 环境与配置诊断 |
| `-v, --version` / `-h, --help` | 版本 / 帮助 |

交互模式下的输入：

- `@path/to/file` 把文件内容附进本条消息
- `@codebase` 先做一次语义检索，把相关代码块附进消息
- `/help` `/clear` `/model <id>` `/cost` `/exit`

## 权限模型

| 模式 | 行为 |
|---|---|
| `plan` | 只读：读文件、搜索；禁止写文件、shell、git 写操作 |
| `default` | 读操作放行；写文件与 shell 需要逐次审批 |
| `acceptEdits` | 写文件放行；shell 仍需审批 |
| `yolo` | 全部放行 |

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
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "providers": {
    "anthropic": { "apiKey": "...", "model": "claude-sonnet-4-5" },
    "openai": { "apiKey": "...", "baseURL": "https://api.openai.com/v1" }
  }
}
```

支持的环境变量：`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`CAKE_PROVIDER`、`CAKE_MODEL`、`ANTHROPIC_BASE_URL`、`OPENAI_BASE_URL`。密钥优先级：显式配置 > 环境变量 > 配置文件。

> 用兼容 Anthropic / OpenAI 协议的本地或第三方端点时，改 `baseURL` 即可。

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
- 没有 `OPENAI_API_KEY` 时自动退化为纯词法检索

## 子 agent

主 agent 可以调用 `agent` 工具派生子 agent：

- `explore` / `plan`：工具被裁剪为只读，适合在大仓库里扫结果、做方案
- `general`：完整工具集
- 子 agent 有独立上下文，只回传结论摘要；token 与成本会汇总进父会话统计
- 同一步里的多个 `agent` 调用并行执行；子 agent 不能再嵌套派生子 agent

## 会话与观测

- 会话历史存 `.cake/sessions/cake.db`，`cake -c` 续跑最近一次
- 历史接近上下文窗口时自动压缩（保留摘要 + 近期消息）
- `CAKE_TRACE=1 cake "..."` 会把工具调用/结果/错误写进 `.cake/logs/run-*.jsonl`（本地文件，默认关闭，不上传任何数据）

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
