# Agent 自身 MCP 接入

目标是让**当前与用户对话的客户端**获得并能调用 SapLink 工具，不是生成一份让用户手动粘贴的文件。新服务器默认名为 `saplink-mcp`；协议自报名称仍可能是 `saplink`，实际工具前缀由客户端决定。

## 发现并复用

1. 检查当前工具、客户端身份及配置入口。已有可用 SapLink 工具时调用 `list_connections` 确认，不创建第二份接入。
2. 检查该客户端有效 MCP 条目、作用域和覆盖关系；只输出名称、URL、启用状态等非秘密字段，不打印完整配置或可能带令牌的 CLI JSON。
3. 复用本次服务的已有条目（包括旧名 `saplink`），无需为改名打断工作。同名 `saplink-mcp` 被其他服务占用时先核实，不覆盖无关服务。
4. 首次接入默认使用当前用户私有配置；用户要求项目级时才使用该作用域，含秘密文件不能入库。容器/远程 Agent 的 `127.0.0.1` 不是用户 Windows 主机，不自行开放公网、部署代理或关闭 Host/Origin 校验。

配置请求包含必要的令牌及客户端接入步骤，不包含扩大 SAP 写权限或关闭客户端审批。保持其他服务器、approvals、sandbox 和工具策略不变。

## 令牌及传输参数

使用 Streamable HTTP，URL 为已核实的 `http://127.0.0.1:<MCP端口>/mcp`，头为 `Authorization: Bearer <token>`。不是 stdio 或旧式 SSE。不能用 `localhost`，管理页面 URL、会话 key 与 MCP 令牌不是同一回事。SAP 连接选择 RFC/JCo 不改变此 MCP 传输协议。

优先复用当前客户端仍有效的凭据。`token list --json` 返回 ID、可选名称和创建时间，不返回令牌值或哈希，不能用 ID 代替 Bearer 令牌。名称只是显示信息，旧令牌可无名称；重命名不会改变认证。已有条目正常时不要求额外令牌文件。确需新客户端令牌且没有可用秘密时，创建一个并记录其 ID 和本地位置，不撤销其他令牌。

```powershell
saplink token create --name "开发助手" --out <新的绝对路径-token.json> --json
saplink client-config --token-file <token.json绝对路径> --out <新的绝对路径-parameters.json> --port <实际MCP端口> --json
```

这是命令结构；执行前替换真实路径和端口，按当前 shell 正确引用。先在当前用户私有配置目录创建父目录，输出文件必须尚不存在。文件已存在时先核实其用途，不为此反复创建新令牌。

修改已知令牌名称可用 `token rename <实际ID> --name "新名称" --json`，无需重新创建或更新客户端秘密。管理页面隐藏 ID，避免用户误用；CLI 的 ID 仅用于定位管理对象。

token 文件含 `id`、`token`，parameters 文件含 `transport`、`url`、`headers.Authorization`。仅在本地脚本中读写秘密，写入客户端支持的字段，不输出秘密、整份配置、备份差异或含令牌的命令参数。`client-config` 是通用参数导出，不完成客户端注册。

## Codex

字段依据 [OpenAI 官方 MCP 文档](https://developers.openai.com/codex/mcp/)；执行时核实本机版本及现有配置，不能假设所有版本都有相同命令或热加载行为。

Codex 使用 TOML 的 `mcp_servers` 表，默认用户路径为 `~/.codex/config.toml`。先解析实际用户目录、`CODEX_HOME` 或显式配置入口，检查项目级 `.codex/config.toml` 等覆盖来源，不硬编码开发者路径。

静态头方式的目标结构如下，**只展示字段，不把占位令牌写入真实配置**：

```toml
[mcp_servers.saplink-mcp]
url = "http://127.0.0.1:8765/mcp"
http_headers = { Authorization = "Bearer <仅由本地脚本填入>" }
```

由 Agent 在本地脚本中从 token/parameters 文件或已确认的现有私有配置读取秘密，用可用的 TOML 解析/编辑能力更新目标表，保留其他设置与注释。写入前创建私有备份，验证候选文件可解析，复核原文件未被其他进程修改后原子替换。无变化不重写、不重复追加表。失败时只恢复未被并发修改的本次配置，不覆盖用户新改动。配置中直接保存的认证头和备份都含秘密，应限制当前用户访问，不提交、上传或展示。

优先使用客户端原生配置接口完成同等字段更新（如果本机版本支持）。先看 `codex mcp --help` / `codex mcp add --help`，不要编造 `--header` 参数。已有且由用户管理的 `bearer_token_env_var` / `env_http_headers` 可复用；不能仅在 Agent 子 shell 设置环境变量就宣称桌面父进程已获取认证，不把 HTTP 环境配置写到 stdio 专用 `env` 字段。

SapLink 使用 Bearer 令牌，不用 `codex mcp login` 发起 OAuth 或改用 ChatGPT 认证。配置条目不代表放宽原有工具审批策略。

## WorkBuddy 及其他客户端

检查客户端自带帮助、现有 MCP 配置和官方说明，确认 Streamable HTTP、URL、静态 Authorization 头的真实字段与作用域，再在本地针对性合并。不假设其使用 Codex TOML、通用 `mcpServers` JSON 或猜测的用户路径。

由 Agent 完成受支持的操作。无法本地发现必要信息时，只问客户端名称/版本或配置入口；明确不支持所需认证/协议时报告具体阻碍，不把参数文件冒充配置成功，也不擅自安装代理软件。

## 验证与重载

| 阶段 | 完成依据 |
| --- | --- |
| 服务就绪 | 核实实际 MCP 端口与实例状态，不只是管理 UI 或 TCP 连通 |
| 配置完成 | 当前客户端有效条目可解析，URL/认证字段匹配，其他条目保留 |
| MCP 连接成功 | 支持的 MCP 客户端完成初始化、读取 instructions 和 tools/list |
| 当前 Agent 已接入 | 当前会话实际发现工具，成功调用 list_connections |
| 目标 SAP 可用 | 明确连接后 get_capabilities 或任务所需的只读操作成功 |

优先使用宿主支持的 MCP 刷新/重连入口。不能热加载时保留已完成配置，告知用户只需重载客户端或开启新会话，之后继续验证；不要求用户手动重配，不自动结束当前对话进程。

工具目录未刷新时，可用已安装环境中的 MCP SDK 建立独立临时客户端；只在内存中读取凭据用于请求头，完成 initialize、listTools、callTool(list_connections, {}) 并正常关闭。只输出非秘密摘要，不为诊断下载安装依赖。这只能证明服务可连，不能证明当前 Agent 已加载工具。GET /mcp 返回 405 不代表故障，不用管理页面代替 MCP 握手。

401 核实令牌和所属配置目录；403 区分 Host/Origin 与 SAP 工具内部错误；连接拒绝核实 MCP 端口。权限限制通过正常权限机制处理，不反复新建令牌。端口变化或令牌轮换时更新受影响条目、重连验证，再处理用户要求的旧令牌撤销；不自动撤销其他客户端的令牌。
