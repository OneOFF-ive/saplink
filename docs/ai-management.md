# AI 终端管理

适用于拥有本机终端执行能力的 AI 客户端，以下统一使用安装后的 `saplink` 命令。默认通过 CLI 和 SapLink 技能配置连接、执行 SAP 对象及数据操作，无需后台服务或令牌。MCP 是供用户自行研究的可选进阶功能。当前管理平台为 Windows，安装包内置运行环境。

## 机器可读入口

MCP 令牌未配置、可选 MCP 端口被占用时，doctor 只给出 warning，不因此判定 CLI 不健康；凭据、配置或必要运行环境失败仍按故障处理。

Windows 安装包用户重新打开终端后，在任意目录使用 `saplink`，无需安装系统 Node.js。源码运行方式单独见 [开发与构建指南](development.md)。机器可读命令示例：

```powershell
saplink version --json
saplink status --json
saplink doctor --json
saplink connection list --json
saplink token list --json
```

结果包含 `schema_version: 1`、`status`，以及 `data` 或 `error`；同时检查进程退出码。诊断完成但发现问题时，doctor 返回 `status=success`、`data.healthy=false` 并退出 1；这表示报告已成功生成，并非环境健康。未知参数、缺少必要输入或操作失败返回 `status=error` 并退出 1。`--help` / `--version` 仍为普通帮助文本。

status 不输出密码、MCP 令牌、后台控制令牌或进程命令行。doctor 检查 Node/Windows、构建、配置、目录写入、令牌、运行锁、空闲端口和当前用户凭据是否存在；只用临时目录探测可写性，不更改连接或权限。默认不访问 SAP。只有显式指定 `doctor --connection dev --json` 才测试该连接登录与 discovery，成功不等于拥有全部 SAP 权限。

`saplink version` 与 `saplink --version` 输出当前应用版本号；`saplink version --json` 在 `data.version` 中返回版本，供 AI 客户端解析。它读取本地安装的版本，不访问网络查询更新。

## 检查新版本

```powershell
saplink update check --json
saplink update check --force --json
```

按用户的更新检查或升级请求执行。默认优先查询 COS 版本清单，不可用时自动回退 GitHub 官方正式 Release，结果缓存 24 小时；`--force` 强制联网刷新。此命令不要求 SAP 登录、MCP 服务运行或令牌，不停止服务、不自动下载或安装。长期运行的 UI、前台或后台服务启动后重新联网检查，此后每小时刷新，不复用 CLI 的 24 小时缓存。可见管理页每 3 秒读取检测结果，发现新版本时在侧栏“软件更新”显示红色 New，进入后直接显示自动更新操作；无新版时保留检查按钮。不弹提醒窗口，不再写入历史通知文件。`SAPLINK_AUTO_UPDATE_CHECK=0` 并重启可关闭自动检查；不为检查版本启动或重启原本未运行的服务。

成功结果的 `data` 包含 `current_version`、`latest_version`、`update_available`、`release_url`、`published_at`、`checked_at`、`cached`、`message`。`checked_at` 是 UTC 时间；`cached=true` 时不是本次联网时间。发现更新时向用户提供返回的发布页面，由用户选择 x64 或 ARM64 安装包，不猜附件 URL。

`latest_version=null` 表示没有可公开访问的正式 Release（也可能是私有仓库），不能将 `update_available=false` 解读为已是最新版。有有效最新版本但没有更新时，也可能是本地开发版本高于发布版。预发布和草稿不会作为更新推荐。

网络、超时、限流及其他 GitHub HTTP 错误返回 `UPDATE_CHECK_FAILED`；无效元数据返回 `UPDATE_RESPONSE_INVALID`，均为 `status=error`、退出 1。失败不使用旧缓存冒充联网结果，不影响现有服务；不反复重试。旧版 CLI 不认识命令时，引导查看[发布页面](https://github.com/OneOFF-ive/saplink/releases)。用户可在受支持的 Windows 安装版中明确选择自动安装。

## 缓存与日志清理

历史审计日志使用 `saplink logs clear --older-than-days 30 --json` 先预览，用户意图包含删除时再加 `--yes`。默认保留 30 天，0 仍保留当天日志。检查 `deleted_files`、`deleted_bytes`、`failed_files` 和退出码，部分失败不应宣称全部成功；不要将审计记录、令牌文件或配置当作普通缓存随意删除。

清理后台连接缓存使用 `saplink cache clear --json`，无需重启服务。检查 `cleared_sessions` 和 `retained_write_requests`；该命令保留写入防重复记录以及全部用户配置。`BUSY` 应等待当前操作结束；`SESSION_NEEDS_REVIEW` 应先核实 SAP 锁；`CACHE_CLEAR_FAILED` 或 `CACHE_CLEAR_UNKNOWN` 不自动重试或重启。UI 持有运行锁时使用其“MCP 服务”页的清理按钮。

## 安全配置连接

```powershell
saplink connection add dev --transport rfc --rfc-ashost sap-host --rfc-sysnr 00 --client 001 --username SAPUSER --language EN --password-prompt --json
saplink connection edit dev --language ZH --disable-writes --json
saplink connection test dev --json
saplink connection remove dev --yes --json
```

`--password-prompt` 弹出本机 Windows 密码窗口，密码通过内部管道送入 Windows 凭据管理器，不出现在 AI 命令输出、参数、环境变量或配置文件里。窗口取消、不可用或超时会失败，不保存新密码。新连接及登录地址/Client/用户名变化时必须重新录入密码；未传该选项时，JSON 模式返回 `INTERACTION_REQUIRED`，不会卡在终端询问中。

新连接默认关闭写入，只有显式 `--enable-writes` 才开启；`--disable-writes` 可关闭。删除时 `--yes` 确认删除指定连接及凭据。登录身份不变的语言/写开关修改不需要读取或重新输入密码。旧的无选项交互式 add/edit 在真实终端中继续可用。

连接修改需要 runtime 停止。AI 应记住原端口，停止自己管理的实例后修改，再恢复服务。前台 UI/serve 不会被后台管理器自动关闭。不要在聊天里传密码；无桌面交互环境下应由用户打开原管理 UI 完成凭据录入。

RFC 不需要 `--url`；需要路由时添加 `--rfc-saprouter /H/router.example/S/3299`，仅填写中转节点。已有路由改直连用 `--clear-rfc-saprouter`。改变传输方式、应用服务器、系统号、路由、Client 或用户名时需重新输入密码。HTTP 新连接显式使用 `--transport http --url https://sap-host:443`，已有 HTTP 连接保持原方式。完整包在管理页检查随包 Java/JCo；不修改全局 `JAVA_HOME` 或 PATH 来修复它。

## 宿主和可选 MCP 的独立生命周期

默认 SAP 操作使用 `saplink sap ...`，无需启动常驻宿主。宿主承载管理 UI 和可选 MCP；只在需要管理界面或 MCP 接入时启动。

```powershell
saplink app start --port 8766 --json
saplink app status --json
saplink mcp start --port 8765 --json
saplink mcp status --json
saplink mcp stop --json
saplink app stop --json
```

`app start` 后台启动宿主和管理监听，不打开浏览器、不启用 MCP，也不要求令牌。`ui` 打开或复用管理页面；该命令是桌面托盘的附着进程，结束附着命令不等于退出宿主。正常退出使用 `app stop` 或托盘退出。`serve` 继续在前台运行带 MCP 的宿主，用原终端 Ctrl+C 正常退出。交互的 `ui/serve` 不支持 `--json`。

`mcp start` 要求已有访问令牌，宿主未运行时按需启动；不会自动创建令牌。`mcp stop` 仅关闭 MCP 并收尾其 SAP 会话，管理页面和宿主保持运行。`app stop` 正常关闭整个常驻宿主，包括 MCP 和管理页面，但不强制终止独立 CLI SAP 进程，不删除连接、凭据、令牌、日志或 CLI 持久写请求记录。

`mcp restart [--port <MCP端口>]` 只重启 MCP，宿主 PID 不变；`app restart [--port <管理端口>]` 重启宿主，保留 MCP 原启用状态、MCP 端口和管理端口。宿主原本停止时，`app restart` 按默认只启用管理监听。MCP 不传端口时优先沿用现有宿主设置，冷启动默认 8765；管理端口冷启动默认 8766。指定的新端口被占用时预检会拒绝操作并保留现有监听；实际绑定仍可能因竞争失败，检查实际返回状态。

| 状态入口 | 解释 |
| --- | --- |
| `app status` | `state` 表示宿主状态，`mcp_running` 表示 MCP 是否运行；`ui_port` 是已开启的管理端口，`port` 是 MCP 端口 |
| `mcp status` | `state` 仅表示 MCP 的 running/stopped/unknown，`app_state` 单独报告宿主；无法验证的旧实例或 guard 存在时为 unknown |
| `status` | 汇总配置及宿主状态，不输出认证秘密 |

两入口共用有身份校验的本机控制接口；不强杀进程、不删锁或接管未知实例。停止等待已有请求及 SAP 会话收尾，超时意味着结果未知，应先查状态，不重复发起控制动作。后台管理不等于 Windows Service、开机自启或崩溃恢复。

`service start/stop/status/restart` 保留兼容行为：start/restart 启动带 MCP 的宿主，stop 关闭整个宿主。新工作流优先使用 `app` 和 `mcp`，不得用 `service stop` 代替仅停止 MCP。已有旧版宿主不支持新控制动作时，应正常退出并更新，不能强制接管。

完整公开命令、参数用途见[技能 CLI 目录](../skills/saplink-manager/references/commands.md)。宿主、页面与 MCP 共享同一个运行锁；各连接配置修改仍使用配置锁，独立 CLI 操作可并存。管理会话 URL 含私密凭据，不输出到聊天或普通日志。

## 可选 MCP 令牌及客户端参数

```powershell
saplink token create --name "开发助手" --out C:\Users\USER\AppData\Roaming\saplink\client-token.json --json
saplink client-config --token-file C:\Users\USER\AppData\Roaming\saplink\client-token.json --out C:\Users\USER\AppData\Roaming\saplink\connection-parameters.json --json
saplink token revoke TOKEN_ID --json
```

替换示例路径与 ID。父目录需要已存在，输出文件必须是新文件，不覆盖已有文件。JSON 结果只返回 ID/路径，不返回明文令牌。JSON 或被重定向的 token create 必须提供 `--out`；真实交互终端仍可一次性显示令牌。

client-config 验证令牌属于当前配置且尚未撤销，再导出 `transport`、`url`、`headers.Authorization`。这只是产品无关连接参数，不是保证适用于 Codex、WorkBuddy 等所有客户端的完整设置文件；AI 应核对目标客户端已有配置格式，保留其他服务器，并在本地脚本内读写令牌，不打印或上传文件。创建参数文件不代表客户端已成功连接。令牌撤销不会删除已写入文件的副本。

## 一个 skill 完成配置与 SAP 工作

项目附带 [saplink-manager](../skills/saplink-manager/SKILL.md)，面向能在用户 Windows 电脑执行本机命令的 AI 客户端。技能默认直接调用 CLI 使用 SAP，同时收录全部公开管理命令。用户要求管理宿主、MCP 或令牌时按需执行；不为普通 SAP 任务自动启用 MCP，不默认修改或移除用户原有客户端配置。

将整个技能目录（包括 `references`、`agents`）导入客户端。用户可以直接说“帮我配置 SapLink 并连接这个 SAP 系统”“查询物料”“修改这个 ABAP 程序”，由 Agent 按需完成安装核实、连接配置、命令发现、登录验证和业务操作。不要只分发 SKILL.md 而遗漏引用文件。

技能先执行 `saplink tools instructions --json` 与 `saplink sap list_connections --json`，再按 `tools describe` 返回的 schema 调用 `saplink sap <operation>`。安装后 PATH 未刷新时，使用已核实的启动器绝对路径继续。命令不可用时先核对版本和入口，不自动改走 MCP。远程/容器终端不能假装拥有用户 Windows 本机的配置与凭据。详细流程见[技能 CLI 接入](../skills/saplink-manager/references/cli-setup.md)。

未安装时，先取得安装同意和路径确认，再优先从 COS、其次从 GitHub 获取官方安装包，核对架构及完整性后安装；不通过构建源码替代安装产品。卸载仅接受明确要求，不将其作为连接故障的常规修复。升级按用户意图执行，保留连接、凭据、日志及已有客户端配置；完成后重新验证 CLI 命令与目标 SAP 只读操作。安装或卸载失败、部分完成、结果未知时报告实际状态，不自动卸载重装。写开关及具体 SAP 变更仍受用户授权和 SAP 权限约束。
