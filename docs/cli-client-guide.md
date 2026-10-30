# AI 通过 CLI 使用 SAP

SapLink 默认通过 CLI 和 SapLink 技能供 AI 使用。支持执行本机命令的 AI 客户端可以直接调用 `saplink`，无需创建 MCP 令牌、启动 MCP 服务或编辑 MCP 配置。MCP 保留为供愿意自行研究接入的用户开放的额外功能。两者共用已保存的 SAP 连接、Windows 凭据、SAP 操作层和写入策略。

业务用户仍通过本机管理页面添加、测试 SAP 连接，密码仅在本机输入。安装后确认终端能运行 `saplink version`；安装时未加入 PATH 的，可以使用安装目录中的命令完整路径。新安装后可能需要重启 AI 客户端，使其获得更新后的 PATH。

CLI 模式要求 AI 客户端具有本机命令执行能力；只有聊天功能、无法执行本机命令的客户端不能直接使用此入口。客户端自身的命令审批策略仍然生效。

## 业务用户怎样开始

完成安装后，在默认“连接配置”首页添加、测试 SAP 连接。将完整 [saplink-manager 技能目录](../skills/saplink-manager/SKILL.md)导入支持本机命令的 AI 客户端，再描述业务任务即可；技能通过 CLI 完成操作，不配置 MCP。也可以直接向 AI 客户端说明：

> 使用本机 SapLink CLI 连接 SAP。先运行 `saplink tools instructions --json` 学习操作要求，通过 `saplink sap list_connections --json` 确认目标系统和 Client，再查询我需要的数据。操作参数通过 JSON 文件或标准输入传递。不要配置 MCP。

用户描述业务任务，AI 负责命令调用。多个连接的目标有歧义时，AI 应先确认目标系统及三位 Client，不得根据连接名称猜测系统用途。

## AI 的调用流程

```text
AI 客户端 ──执行命令──> saplink sap <operation> ──> SAP 操作层 ──HTTP 或 RFC/JCo──> SAP
AI 客户端 ──MCP──────> SapLink MCP 服务 ────────> 同一 SAP 操作层
```

```powershell
saplink tools instructions --json
saplink tools list --json
saplink tools describe query_table --json
saplink sap list_connections --json
saplink sap get_capabilities --connection <实际连接UUID> --json
```

`tools list` 返回当前版本的完整操作目录、说明和写操作标识。`tools describe <operation>` 返回 JSON Schema，与 MCP 使用同一份参数定义。`saplink sap --help` 也列出所有操作。不需要 SAP 登录即可发现接口。

例如，创建 UTF-8 文件 `query.json`，内容如下：

```json
{
  "table_name": "MARA",
  "fields": ["MATNR", "MTART"],
  "limit": 20
}
```

```powershell
saplink sap query_table --connection <实际连接UUID> --input query.json --json
```

也可通过管道传递一个 JSON 对象：

```powershell
'{"table_name":"MARA","limit":20}' | saplink sap query_table --connection <实际连接UUID> --input - --json
```

所有操作参数也可以放在输入文件中，包括 `connection_id`。与 `--connection` 同时提供时必须一致。输入上限为 2 MiB；不传 `--input` 时按空对象校验，不会等待终端交互。源码、SQL 和复杂过滤条件建议使用文件或标准输入，避免 shell 引号及转义问题。不要把密码或 MCP 令牌放进输入。

## 管理 SapLink、MCP 与令牌

同一个技能也支持按用户要求管理产品：`app start/stop/status/restart` 控制常驻宿主，`mcp start/stop/status/restart` 仅控制可选 MCP。`app stop` 同时关闭管理页面和 MCP；`mcp stop` 保留宿主和管理页面。二者都不强制终止独立 SAP CLI 进程。`app start` 默认不启用 MCP，宿主重启保留 MCP 原启用状态及端口。

连接、令牌、诊断、更新、缓存和日志命令均保留，完整用法见[技能命令目录](../skills/saplink-manager/references/commands.md)，状态含义和管理流程见 [AI 终端管理](ai-management.md)。默认 SAP 业务任务不会自动启动 MCP 或创建令牌；用户明确要求相应管理操作时，技能再按需执行。旧 `service` 命令仅保留兼容语义，不用它代替“仅停 MCP”。

## 本次调用的超时时间

访问 SAP 的命令接受 `--timeout-ms <毫秒>`，也可以在输入 JSON 中提供数值型 `timeout_ms`。例如对保存后的源码做语法检查：

```powershell
saplink sap syntax_check --connection <实际连接UUID> --input check.json --timeout-ms 60000 --json
```

`check.json` 填入从 SAP 返回的真实 `object_uri` 和 `version`。两个位置同时提供超时时间时必须一致。合法范围为整数 100～600000 毫秒（最长 10 分钟）；不传时保留默认值：HTTP 通常 15 秒，RFC 沿用运行环境设置，RFC CTS 查询默认至少 60 秒。显式参数覆盖这些默认值，包括 CTS 特殊值。

这是本次操作内**每个 SAP 请求**的等待时间，包含登录、元数据、保存及读回校验；不是整个命令的总时限。一个操作可能发出多个请求，总耗时可能更长。参数不会保存到连接、修改环境变量或影响其他调用。本地 `list_connections` 不访问 SAP，不接受此参数。

AI 客户端自身的命令/工具等待时间也需要足够长。延长 SapLink 的等待时间不能覆盖客户端的提前取消，也不能改变 SAP 服务器自己的限制。写操作超时后仍应核实实际状态；更换超时时间不能绕过 CLI 写请求 ID 防重复保护。

## 结果与失败处理

`--json` 输出一个 JSON 对象：

```json
{
  "schema_version": 1,
  "status": "success",
  "data": {
    "operation_id": "...",
    "status": "success",
    "completed_steps": [],
    "data": {}
  }
}
```

外层 `data` 为完整 SAP 操作结果，包含操作 ID、步骤、业务数据及可能的警告。SAP 操作失败时外层 `status` 为 `error`，错误在 `data.error`；参数或本地启动失败时错误在外层 `error`。成功退出码为 0，失败为 1。必须同时检查退出码、状态与详细结果。

CLI 保留 `outcome`、`write_dispatched`、`source_save` 等写入信息；错误不能解释为“SAP 未改变”。保存、语法检查和激活继续分步执行，未知或部分完成的结果先读回 SAP 状态，不能盲目重试。

## 写入、进程与并存

每次 CLI 操作独立建立并关闭 SAP 会话，不启动本地监听端口。连接默认只读，写操作仍要求本地开启写入，并遵守 SAP 权限、对象锁、revision、传输任务以及执行确认等现有规则。CLI 与 MCP 可以并存，但各自使用独立 SAP 会话和请求跟踪；不得通过另一入口重放写请求。

CLI 在写操作发出前，将连接 ID 与 `request_id` 的组合持久保留到配置目录的 `cli-write-requests` 子目录。同一连接的请求 ID 跨写操作共用，同一请求的再次调用会返回 `REQUEST_ALREADY_USED`，即使第一次失败或进程中断也不会重新执行。这是防重复标记，不是成功证明或结果缓存；同一个 ID 不会返回之前的完整结果。标记不存源码、行数据或密码，不自动过期，不应为重试删除。需要恢复时，先根据操作日志和 SAP 当前状态人工复核，确定新的变更意图后再使用新 ID。

一次 CLI 调用持有配置锁，避免调用期间通过正常管理入口修改连接；另一个 CLI 调用或连接配置变更可能暂时返回忙状态。MCP 使用自身运行锁、会话队列与写请求缓存；两入口之间不提供全局任务队列或事务，SAP 锁和版本校验仍然适用。不要在两个入口同时编辑同一对象。

当前源码接入了与 MCP 共用的 SAP 操作目录。具体能力仍取决于 SAP 版本与权限；本地模拟测试不代表已完成真实 SAP 联调。安装版需要重新构建并发布，已有安装不会因源码变化自动获得新命令。
