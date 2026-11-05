# MCP 集成

cake 作为 MCP **客户端**连接外部 server，把它们的工具发现、适配后暴露给模型。

## 配置文件位置

按以下顺序加载，同名 server 由项目配置覆盖全局配置：

1. `~/.cake/mcp.json`（全局）
2. `<workspace>/.cake/mcp.json`（项目）

文件不存在视为「没有配置」；JSON 或 schema 出错会直接报错，并在 `cake --doctor` 中显示为 failure。

## 结构

```json
{
  "mcpServers": {
    "<server 名>": { ... }
  }
}
```

server 名会进入工具名，只允许字母、数字、下划线（其他字符替换为 `_`）。

### stdio server

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/work/repo"],
      "env": { "DEBUG": "0" },
      "cwd": ".",
      "permission": "read",
      "maxTools": 24
    }
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `command` | 是 | 可执行文件；建议用绝对路径或 PATH 中稳定的命令 |
| `args` | 否 | 参数数组，不经 shell，无注入风险 |
| `env` | 否 | 追加到默认环境变量之上；不会清空继承的环境 |
| `cwd` | 否 | 相对路径以**配置文件所在目录**为基准（全局配置即 home，项目配置即工作区） |
| `permission` | 否 | `read` / `write` / `shell`，强制覆盖工具注解推断 |
| `maxTools` | 否 | 直接暴露的工具数上限，默认 24 |

stdio server 的 stderr 会透传到当前终端，方便排查启动失败。

### HTTP server

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
      "permission": "write",
      "maxTools": 12
    }
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `url` | 是 | Streamable HTTP endpoint |
| `headers` | 否 | 附加请求头 |
| `permission` / `maxTools` | 否 | 同 stdio |

## 环境变量展开

`command`、`args`、`env`、`cwd`、`url`、`headers` 的值都支持 `${VAR}`：

```json
{
  "mcpServers": {
    "github": {
      "command": "${MCP_BIN}",
      "url": "https://${MCP_HOST}/mcp"
    }
  }
}
```

引用的变量不存在时加载会失败并指出变量名，而不是把空串悄悄传给 server。

## 权限推断

每个工具按以下顺序决定权限类别：

1. 配置里的 `permission`
2. server 工具注解的 `readOnlyHint: true` → `read`
3. 其余 → `write`

也就是说，只读工具在 `plan` 模式与只读子 agent 中可用，写类工具仍受审批与规则约束。

## 工具命名与大目录

- 工具名：`mcp__<server>__<tool>`，例如 `mcp__filesystem__read_file`
- 同 server 内工具名冲突（少见）时自动追加 `_2`、`_3`
- 超过 `maxTools` 的工具不直接暴露，改为一个 `mcp__<server>__more` 工具：
  - `{ "action": "list" }`：返回被隐藏工具的 name / description / inputSchema
  - `{ "action": "call", "tool": "<name>", "arguments": { ... } }`：调用其中一个
- 这样既能接入 GitHub 这类上百工具的 server，又不会让提示词膨胀

## 失败与超时

- 单个 server 连接或 `listTools` 超时 15 秒 → 记为 warning，跳过该 server
- 工具调用超时 120 秒 → 作为工具错误返回给模型
- 任一 server 失败不会中断整个任务；`[mcp] connected ...` 汇总只列出成功的 server
- 工具返回 `isError: true` 时，内容会被转成异常文本交回模型

## 调试建议

1. 先单独运行 server 命令，确认它能启动（stdio server 通常在 stdin 上等待 JSON-RPC）
2. `cake --doctor` 查看配置是否被正确读取、有多少 server、名称与 transport
3. 用 `CAKE_TRACE=1` 观察 `mcp__*` 工具的调用入参与结果
4. 写操作类 server 建议显式设置 `permission`，避免注解缺失时被误判为只读或反之

## 示例

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "permission": "write"
    },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
      "permission": "read",
      "maxTools": 16
    },
    "docs": {
      "command": "node",
      "args": ["./tools/docs-server.mjs"],
      "cwd": ".",
      "env": { "DOCS_ROOT": "${DOCS_ROOT}" }
    }
  }
}
```
