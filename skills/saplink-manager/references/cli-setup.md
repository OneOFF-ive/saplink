# AI 客户端通过 CLI 接入

优先使用用户 Windows 电脑上已安装的 `saplink` 命令。客户端能执行本机命令时，直接使用 CLI。用户要求管理 MCP 或令牌时，另按 [MCP 管理](mcp-management.md)执行。

## 找不到 saplink 命令

- **同一台 Windows 电脑和同一用户，只有 PATH 查找失败**。核对当前用户的安装注册表和安装清单，见[安装检查](installation.md#先确认安装是否真的缺失)。使用已核实安装目录中的 `bin\saplink.exe` 绝对路径执行 `version --json`，验证通过后沿用该路径。该启动器使用安装包自带的 Node.js，系统 PATH 无需包含 `node`。
- **本机沙箱限制执行、文件、凭据或回环访问**。按客户端提供的权限机制核实；已有受支持的本机执行入口时，在权限允许的范围内使用。区分命令不可见、启动被拒绝和运行后访问失败。
- **远程沙箱、容器、不同 Windows 用户或无法核实本机身份**。当前执行环境找不到命令，只能说明该环境无法直接调用 CLI。只有在用户本机及相应账户中核实安装确实缺失后，才进入安装流程。

CLI 入口不可用且用户未限定使用 CLI 时，可通过当前客户端**已配置且获准使用的 SapLink MCP**继续业务操作。先发现工具，调用 `list_connections` 核对目标系统及 Client，再用 `get_capabilities` 或任务所需的最小只读操作验证。安装、升级和宿主管理仍使用已核实的本机入口。写入返回结果不明确时，先核实 SAP 状态，避免换入口重放。

两个入口均不可用时，说明受限的位置，并提示在用户 Windows 电脑的 PowerShell 中运行 `saplink version --json` 核实本机入口。包含内置助手的版本也可在 SapLink 的「工作空间」继续任务。MCP 默认只监听 SapLink 主机的回环地址，远程沙箱自己的 `127.0.0.1` 无法访问它。接入需要客户端已有可达且获准使用的连接，切换入口不授权开放端口、建立代理、生成或转发令牌。

## 确认入口

1. 解析 `saplink` 并执行 `saplink version --json`。找不到命令时，检查当前用户已注册的 SapLink 安装目录和 PATH，使用已核实的启动器绝对路径继续；不要执行未知目录的同名文件。
2. 执行 `saplink tools instructions --json`、`saplink tools list --json`。旧版没有这些命令时，说明需要升级；不能把服务运行状态当成 CLI 功能已经可用。
3. 执行 `saplink sap list_connections --json`，确认目标服务器、三位 Client 和 `connection_id`。
4. 执行 `saplink sap get_capabilities --connection <真实UUID> --timeout-ms 60000 --json` 或任务需要的最小只读操作，核实真实 SAP 访问。

安装后当前客户端可能尚未加载新的 PATH。使用启动器绝对路径即可继续；新开的客户端应能直接解析命令。终端访问用户配置、Windows 凭据或进程信息被限制时，先通过允许的权限机制核实，不能据此判定凭据丢失或重新要求密码。

## 使用安装包自带的 Node.js

启动器失败时，记录退出码、标准错误、执行用户和 shell。2.1.0 的启动器可能把进程启动错误提示为缺少 Node.js。按[安装检查](installation.md#先确认安装是否真的缺失)确认实际安装目录，再核对该目录中的 `runtime\node.exe` 和 `app\dist\cli.js`。如果客户端允许直接执行该本机程序，可用下面的命令验证。`$saplinkInstall` 为核实后的安装目录绝对路径，支持自定义位置、空格和中文。

```powershell
& (Join-Path $saplinkInstall 'runtime\node.exe') (Join-Path $saplinkInstall 'app\dist\cli.js') version --json
```

验证通过后，普通 `tools` 和 `sap` 命令可沿用这两个绝对路径。先验证工具发现和连接列表，再访问 SAP。直接执行成功只说明本次入口可用，启动器故障原因仍需根据原始错误核实。自动升级、宿主管理和原生密码窗口使用安装版启动器，并单独验证。若客户端明确拒绝执行，按客户端权限机制处理。远程沙箱需有客户端提供的 Windows 本机执行入口，或使用已配置的可达 MCP。

## 发现与调用操作

```powershell
saplink tools describe query_table --json
saplink sap query_table --connection <真实UUID> --input <UTF-8参数文件> --timeout-ms 60000 --json
```

JSON 文件只包含该操作 schema 接受的参数，也可以通过 `--input -` 管道传入。未传输入时按空对象校验，不在非交互终端等待输入。优先使用 UTF-8 文件传递源码、中文和复杂过滤条件，避免 shell 引号及管道编码问题。文件中与 `--connection`、`--timeout-ms` 同时提供的值必须一致。

本机 CLI 每次调用独立登录并关闭 SAP 会话。服务未运行不是业务查询的故障；不要因为 `doctor` 报告可选服务或令牌未配置而创建它们。诊断项要按目标任务判断。
