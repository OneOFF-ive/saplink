# AI 客户端通过 CLI 接入

本技能使用安装后的本机 `saplink` 命令。AI 客户端必须能执行用户 Windows 电脑上的命令；默认无需编辑客户端连接配置、创建令牌或启动后台服务。用户要求管理 MCP 或令牌时，另按 [MCP 管理](mcp-management.md)执行。

## 确认入口

1. 解析 `saplink` 并执行 `saplink version --json`。找不到命令时，检查当前用户已注册的 SapLink 安装目录和 PATH，使用已核实的启动器绝对路径继续；不要执行未知目录的同名文件。
2. 执行 `saplink tools instructions --json`、`saplink tools list --json`。旧版没有这些命令时，说明需要升级；不能把服务运行状态当成 CLI 功能已经可用。
3. 执行 `saplink sap list_connections --json`，确认目标服务器、三位 Client 和 `connection_id`。
4. 执行 `saplink sap get_capabilities --connection <真实UUID> --timeout-ms 60000 --json` 或任务需要的最小只读操作，核实真实 SAP 访问。

安装后当前客户端可能尚未加载新的 PATH。使用启动器绝对路径即可继续；新开的客户端应能直接解析命令。终端访问用户配置、Windows 凭据或进程信息被限制时，先通过允许的权限机制核实，不能据此判定凭据丢失或重新要求密码。

## 发现与调用操作

```powershell
saplink tools describe query_table --json
saplink sap query_table --connection <真实UUID> --input <UTF-8参数文件> --timeout-ms 60000 --json
```

JSON 文件只包含该操作 schema 接受的参数，也可以通过 `--input -` 管道传入。未传输入时按空对象校验，不在非交互终端等待输入。优先使用 UTF-8 文件传递源码、中文和复杂过滤条件，避免 shell 引号及管道编码问题。文件中与 `--connection`、`--timeout-ms` 同时提供的值必须一致。

本机 CLI 每次调用独立登录并关闭 SAP 会话。服务未运行不是业务查询的故障；不要因为 `doctor` 报告可选服务或令牌未配置而创建它们。诊断项要按目标任务判断。

远程/容器 Agent 的命令运行位置与用户 Windows 电脑不同，不能通过自身终端直接访问用户的配置和 Windows 凭据；说明此限制，不擅自开放公网、部署代理或转发凭据。已有 MCP 客户端设置不影响此技能通过 CLI 执行任务，也不应为迁移删除。
