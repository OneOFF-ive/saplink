# 全部公开 CLI 命令

本页覆盖产品公开的命令入口。先使用已核实的安装版；每组可用 `saplink <组> --help` 或完整子命令的 `--help` 查询当前版本选项。内部 `_run` 仅供启动器使用，不是 Agent 的管理入口。默认业务任务直接用 `sap`；只有用户要求管理相应功能时才使用宿主、MCP 或令牌命令。

除 `ui`、`serve` 和帮助文本外，Agent 使用 `--json`，检查退出码和结果。管理命令的业务结果通常在外层 `data`；`sap` 的外层 `data` 则是完整 SAP 操作结果，其业务数据在下一层 `data`。

## 版本、帮助和诊断

| 命令 | 用途 |
| --- | --- |
| `saplink --help` / `saplink help <命令>` | 查看真实命令和选项；返回帮助文本 |
| `saplink --version` / `saplink version --json` | 本地版本，不联网 |
| `saplink status --json` | 配置数量、目录及常驻宿主状态，不输出秘密 |
| `saplink doctor --json` | 本地环境诊断，不访问 SAP |
| `saplink doctor --connection <连接名称> --json` | 显式测试该 SAP 登录和能力发现 |

doctor 支持 `--port <MCP端口>` 检查可选端口。缺少 MCP 令牌或可选端口被占用不是独立 CLI 访问 SAP 的故障；仍须检查必要运行环境和凭据。

## SapLink 宿主

| 命令 | 用途 |
| --- | --- |
| `saplink app status --json` | 常驻宿主状态；另看 `mcp_running`、`ui_port` 和 `port` |
| `saplink app start [--port <管理端口>] --json` | 后台启动宿主和管理监听，默认 8766，不启用 MCP、不打开浏览器 |
| `saplink app stop --json` | 正常关闭已验证宿主及其 UI、MCP，不终止独立 SAP CLI 进程 |
| `saplink app restart [--port <管理端口>] --json` | 重启宿主，保留 MCP 原启用状态及端口；未运行时按默认只启动宿主 |
| `saplink ui [--port <管理端口>] [--no-open]` | 复用或启动宿主，打开管理页面；当前命令保持附着供桌面托盘使用 |

`ui` 是交互命令，不支持 `--json`；自动化启动使用 `app start`。关闭浏览器或终止 UI 附着命令不等于退出宿主，退出用 `app stop` 或托盘退出。管理会话 URL 含私密凭据，不输出到聊天。无法确认身份的旧版、外部或无响应实例不会被接管，先诊断。

## 可选 MCP 服务

| 命令 | 用途 |
| --- | --- |
| `saplink mcp status --json` | MCP 的实际状态；`app_state` 单独表示宿主状态 |
| `saplink mcp start [--port <MCP端口>] --json` | 在宿主内启用 MCP；宿主未运行则按需启动，不自动创建令牌 |
| `saplink mcp stop --json` | 仅停止 MCP 并收尾其 SAP 会话，保留宿主、管理页面及配置 |
| `saplink mcp restart [--port <MCP端口>] --json` | 只重启 MCP，宿主 PID 和管理页面保持不变 |
| `saplink serve [--port <MCP端口>]` | 前台运行带 MCP 的宿主，原终端 Ctrl+C 正常退出 |

不传 MCP 端口时优先保留宿主记录的端口，冷启动默认 8765；前台 `serve` 默认 8765。MCP 必须有访问令牌，见 [MCP 与令牌管理](mcp-management.md)。状态未知或控制结果未知时先检查，不循环启停、强杀或删锁。MCP 重启会结束其进程内 SAP 会话及请求缓存，不代表可以重试未知写入。

### 旧 service 命令

`service status/start/stop/restart` 继续保留兼容语义：`start/restart [--port <MCP端口>]` 启动带 MCP 的宿主，`stop` 关闭整个宿主，`status` 的 `state` 是宿主状态，必须另外看 `mcp_running`。新工作流优先用 `app` 和 `mcp`，不能把 `service stop` 当成仅停 MCP。

```powershell
saplink service status --json
saplink service start --port <MCP端口> --json
saplink service restart --json
saplink service stop --json
```

## SAP 连接管理

| 命令 | 用途 |
| --- | --- |
| `saplink connection list --json` | 列出已保存连接 |
| `saplink connection add <名称> [选项] --json` | 添加连接；缺少登录密码时用本机输入窗口 |
| `saplink connection edit <名称> [选项] --json` | 编辑指定连接，保留未修改字段 |
| `saplink connection test <名称> --json` | 测试登录及 discovery，结束后关闭会话 |
| `saplink connection remove <名称> --yes --json` | 用户明确删除该连接时移除其配置和凭据 |

添加/编辑支持 `--transport http|rfc`、`--url`、`--client`、`--username`、`--language`、`--rfc-ashost`、`--rfc-sysnr`、`--rfc-saprouter`、`--clear-rfc-saprouter`、`--http-transport`、`--enable-writes`、`--disable-writes`、`--password-prompt`。不传密码参数；详细录入与锁要求见 [配置管理](local-management.md)。

## MCP 令牌与参数导出

| 命令 | 用途 |
| --- | --- |
| `saplink token list --json` | 返回 ID、名称、创建时间，不返回令牌明文 |
| `saplink token create [--name <名称>] --out <新的私有文件> --json` | 创建并将秘密写入新文件；不在捕获输出中显示 |
| `saplink token rename <ID> --name <新名称> --json` | 改显示名称，不改变认证或令牌值 |
| `saplink token revoke <ID> --json` | 撤销该令牌；后续认证失效，保留其他令牌 |
| `saplink client-config --token-file <文件> --out <新文件> [--port <MCP端口>] --json` | 导出通用 MCP 连接参数，文件含认证秘密 |

令牌只用于 MCP，不是 SAP 密码。导出参数不等于配置了 AI 客户端，也不等于已验证客户端连接。详见 [MCP 与令牌管理](mcp-management.md)。

## 更新与清理

| 命令 | 用途 |
| --- | --- |
| `saplink update check [--force] --json` | 检查可用更新，普通查询可使用缓存 |
| `saplink update install --yes --json` | 用户已授权升级时校验、移交独立更新助手；检查最终安装结果 |
| `saplink cache clear --json` | 清理常驻 MCP 的空闲 SAP 会话，不启动宿主，不删写请求记录 |
| `saplink logs clear --older-than-days <天数> --json` | 预览历史日志清理，默认 30 天 |
| `saplink logs clear --older-than-days <天数> --yes --json` | 用户要求删除相应历史日志时执行；0 仍保留当天 UTC 日志 |

更新见 [更新流程](updates.md)。缓存清理或重启不解除独立 CLI 的持久写请求保护；日志不是源码备份。

## SAP 操作发现与执行

| 命令 | 用途 |
| --- | --- |
| `saplink tools instructions --json` | 读取运行时 SAP 操作要求 |
| `saplink tools list --json` | 完整 SAP 操作目录及写操作标识 |
| `saplink tools describe <操作> --json` | 实时参数 schema 与说明 |
| `saplink sap <操作> --connection <UUID> --input <UTF-8文件或-> [--timeout-ms <毫秒>] --json` | 默认的 SAP 访问入口，不依赖宿主和 MCP |

`sap list_connections --json` 不需要连接参数；它是本地列表操作，不接受超时参数。其他操作按各自 schema 填写输入，字段冲突或未声明参数会被拒绝。当前版本的全部 SAP 子命令以 `tools list` 为准，具体工作流见 [SAP 操作](sap-tools.md)。
