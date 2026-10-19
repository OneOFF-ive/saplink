# 运行与配置管理

使用已核实的安装版 `saplink`；PATH 未刷新时用其绝对路径。不要通过 npm 包装命令或直接改写 SapLink 配置 JSON、连接 UUID。

## 状态与诊断

```powershell
saplink version --json
saplink status --json
saplink doctor --json
saplink connection list --json
saplink token list --json
```

CLI 返回 `schema_version`、`status`、`data` 或 `error`；同时检查退出码。doctor 的 `status=success` 只说明报告已生成；退出 1、`data.healthy=false` 表示诊断未通过。默认不访问 SAP；`doctor --connection <实际名称> --json` 或 `connection test <名称> --json` 才测试该 SAP 登录和 ADT discovery，成功不等于拥有所有业务权限。

| 服务状态 | 如何处理 |
| --- | --- |
| `stopped` | 用户要求接入、启动或通过 SapLink 访问 SAP 时，先确保有令牌，再正常启动后台 MCP；纯状态查询保持停止 |
| `running` 且 `managed=true` | 控制接口已确认宿主；还须检查 `mcp_running`，为 false 时仅管理界面可用，不能报告 MCP 已启动 |
| `external` | 独立 UI、旧版 serve 或其他未提供控制接口的实例持有运行锁，尚不能断定 MCP 是否运行 |
| `unknown` / `unresponsive` | 核实权限、实例身份及诊断，不覆盖或强制重启 |

还要检查 `lease.guard_present`，存在 guard 时先调查，不删除锁。受限执行环境引起的访问失败，应通过允许的权限机制核实，而非改写权限或重新录入凭据。

### UI 与 MCP 是两种状态

UI 默认 `127.0.0.1:8766`；MCP 默认 `127.0.0.1:8765/mcp`。UI 即使尚未启动 MCP，也会持有 runtime 锁，CLI 因而返回 `external`。进程监听的端口可能只有管理端口。

新版 `service start` 和 `serve` 提供共享宿主：服务运行后打开桌面软件或 `ui`，会复用同一后台 Node 进程并显示实际 MCP 状态，不要求先停止服务。重复打开不重启 MCP、不清空请求防重复记录。页面停止 MCP 后宿主保持运行，CLI 状态为 `running,mcp_running=false`；用户要求启动时可用 `service start` 在原 PID 恢复。`service stop` 或托盘退出会正常关闭整个共享宿主；关闭浏览器页面不会停止服务。管理会话 URL 含认证信息，不输出到聊天或普通日志。

有浏览器操作能力时，在已有且已授权的管理页面查看“MCP 服务”页的实际状态、端口，用页面的“启动服务”/“停止服务”正常操作。停止页面内 MCP 不等于退出整个管理进程；退出应用用托盘菜单。不读取浏览器私有数据库或泄露管理会话 URL，不将管理认证用于 MCP。

CLI 修改连接或转成后台托管时，先正常退出持锁 UI；可用已有 UI 操作能力完成，没有正常关闭通道时说明需用户退出托盘程序的原因。前台 serve 使用其原有终端正常退出；无控制通道时请用户完成该最小动作。不得用 taskkill、Stop-Process、删锁或结束未经验证的 PID 接管实例。

## SAP 连接与密码

从 `connection list` 确认真实名称、URL、Client、用户名，不根据 dev/prod 名称推断系统用途。新连接使用：

```powershell
saplink connection add dev --url https://sap-host:443 --client 001 --username SAPUSER --language ZH --password-prompt --json
```

执行前替换为已确认的实际值。名称只允许英文字母、数字、`_`、`-`，最长 80 字符；Client 恰好三位半角数字，保留前导零。URL 为 HTTP/HTTPS 主机及端口，可带 `/sap/bc/adt`；不含其他路径、查询参数、片段或内嵌凭据。

提前告知会弹出本机密码窗口，由用户录入。密码保存在当前 Windows 用户的凭据管理器，按连接 UUID 索引；不得从聊天、环境变量或 CLI 参数获取密码。JSON 模式缺密码返回 `INTERACTION_REQUIRED`；取消输入后不自动重试。无桌面交互环境时说明阻碍，使用可用的本机管理窗口完成凭据录入。

编辑用 `connection edit <name>`，支持 `--url`、`--client`、`--username`、`--language`、`--password-prompt`、`--enable-writes`、`--disable-writes`。登录地址、Client 或用户名改变时必须重新录入密码，仅改语言或写开关不需要。

CLI 连接增删改要求整个 runtime 停止。记录托管服务原端口，正常停止 → 修改 → 测试目标连接 → 恢复原端口。修改未保存但原服务可恢复时也恢复它，报告错误。外部 UI 必须先正常退出，不把关闭其 MCP 子服务视为已释放锁。

仅在用户意图是删除特定连接及其凭据时，使用 `connection remove <name> --yes --json`，不清空其他连接。

## 后台启停

```powershell
saplink service start --port 8765 --json
saplink service status --json
saplink service restart --json
saplink service stop --json
```

首次启动要求至少一个 MCP 令牌，按客户端接入说明创建。优先复用已有端口；冲突时核实占用，不接管其他程序。改端口用 `service restart --port <新端口> --json`，并同步客户端 URL；restart 不传端口保留当前托管端口。

stop 等待请求与 SAP 会话清理，完成后再查 status。`SERVICE_START_UNKNOWN` / `SERVICE_STOP_UNKNOWN` 后先查状态，不盲目重试。`ui`、`serve` 是前台命令，不作为 Agent 回合中的后台启动方式。后台托管不提供开机自启或崩溃自动恢复。

## 缓存、日志和版本维护

- `saplink cache clear --json` 清理托管服务的空闲 SAP 会话，保留配置、凭据、令牌及写请求去重记录。`BUSY` 等待；`SESSION_NEEDS_REVIEW` 核实 SAP 锁；失败或未知不盲目重启。UI 实例使用其缓存按钮。
- `saplink logs clear --older-than-days 30 --json` 先预览。用户意图包含删除相应历史日志时才加 `--yes`；0 仍保留当天（UTC）日志。检查 `failed_files`，部分失败不能报告全部完成。日志不是源码备份。
- 查询本地已安装版本用 `saplink version --json`，查询新版本按下节执行。

配置目录以 `status.data.config_directory` 为准，默认 `%APPDATA%\saplink`，可由 `SAPLINK_CONFIG_DIR` 覆盖。日志默认 `%LOCALAPPDATA%\saplink\logs`，可由 `SAPLINK_LOG_DIR` 覆盖。配置备份不包含 Windows 凭据，不承诺换用户/机器自动恢复密码。

## 版本检查与升级

版本检查、COS 自动升级、用户确认及安装结果验证统一按[版本检查与自动升级](updates.md)执行。检查到新版后，主动询问用户是否需要立即自动更新；获得同意后才安装。仅检查版本不停止服务、不下载安装包。
