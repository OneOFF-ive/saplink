# 按需管理 MCP 与访问令牌

仅在用户要求启动/停止 MCP、管理令牌或导出接入参数时读取并执行本页。默认 SAP 查询与开发仍走独立 CLI，不为此启用 MCP，也不自动编辑当前或其他 AI 客户端的配置。

## 判断宿主与 MCP 状态

先执行 `saplink app status --json`、`saplink mcp status --json`。`app.state=running` 只说明宿主运行；MCP 是否运行看 `mcp.state`，未知时不能报为已启动。未启用 MCP 的宿主、管理 UI 可独立运行；MCP 停止也不妨碍 `saplink sap ...`。

MCP `start/stop/restart` 只控制监听器。冷启动 `mcp start` 可按需创建宿主；`mcp stop` 保留宿主及 UI。`app stop` 关闭整个常驻宿主，包括 MCP；不终止独立 CLI SAP 调用。用户仅要求停止 MCP 时不要执行 `app stop` 或兼容命令 `service stop`。

## 创建或管理令牌

`token list --json` 核实已保存令牌。ID 是管理定位符，不是认证秘密，不能用于 Bearer 头。已有令牌不返回明文；创建新客户端令牌前核实用户意图，不撤销他人的令牌。

```powershell
saplink token create --name "指定用途" --out <新的本机私有文件> --json
saplink token rename <真实ID> --name "新名称" --json
saplink token revoke <真实ID> --json
```

Agent 在当前用户私有目录创建输出父目录，使用尚不存在的文件。只在本机脚本中读写令牌，不输出明文、完整认证头、文件内容、配置备份差异或管理会话 URL。重命名不影响认证；撤销影响后续 MCP 请求，不承诺取消已在执行的 SAP 操作，也不删除客户端保存的副本。新建或撤销令牌不扩大 SAP 权限。

## 启停 MCP

用户要求启用 MCP 已授权正常启动所需宿主；需要新令牌时按用户明确的接入/令牌意图处理，不重复询问每条命令。启动前至少有一个有效令牌，没有令牌时命令会拒绝启动。

```powershell
saplink mcp start --port <实际端口> --json
saplink mcp status --json
saplink mcp stop --json
saplink mcp restart --json
```

省略端口优先保留现有宿主的设置，冷启动默认 8765。只有明确要求改端口时才指定新值。新端口被占用时不接管其他服务，保留原监听；报告实际错误。`MCP_CONTROL_UNKNOWN`、无响应或 guard 存在时，先核对状态及在途操作，不盲目重试。停止/重启会等待 MCP 在途操作收尾，超时不代表 SAP 已停止或回滚。

MCP 重启后进程内请求缓存不再可用，不能靠重启来重复执行未知写入。独立 CLI 的持久请求记录不会被 MCP 启停清除。

## 导出连接参数

用户要求导出时使用真实令牌文件和实际端口：

```powershell
saplink client-config --token-file <私有令牌文件> --out <新的私有参数文件> --port <实际端口> --json
```

导出的是 `transport/url/headers` 通用参数，文件含秘密；不是任何特定客户端的完整设置文件。不得把“文件已生成”报告为“当前客户端已连接”。本技能不默认登记 MCP 服务器或修改客户端配置；用户另行明确要求客户端接入时，按该客户端实际支持的入口处理并保留其他设置。

验证本地 `mcp status`、初始化/工具发现和真实 SAP 登录是不同层次。仅管理服务时报告已验证的监听状态；没有进行客户端或 SAP 验证就不声称它们成功。停止 MCP、撤销令牌都不会关闭独立 CLI 的本机访问能力。
