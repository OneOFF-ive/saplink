# AI 终端管理

适用于拥有本机终端执行能力的 AI 客户端，以下统一使用安装后的 `saplink` 命令。CLI 负责管理服务本身，MCP tools 负责 SAP 对象和数据操作；服务未启动时仍可调用 CLI。当前管理平台为 Windows，安装包内置运行环境。

## 机器可读入口

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

按用户的更新检查或升级请求执行。默认仅查询 COS 版本清单，不可用时报告失败，不自动请求 GitHub，结果缓存 24 小时；`--force` 强制联网刷新。此命令不要求 SAP 登录、MCP 服务运行或令牌，不停止服务、不自动下载或安装。长期运行的 UI、前台或后台服务启动后重新联网检查，此后每小时刷新，不复用 CLI 的 24 小时缓存。可见管理页每 3 秒读取检测结果，发现新版本时在侧栏“软件更新”显示红色 New，进入后直接显示自动更新操作；无新版时保留检查按钮。不弹提醒窗口，不再写入历史通知文件。`SAPLINK_AUTO_UPDATE_CHECK=0` 并重启可关闭自动检查；不为检查版本启动或重启原本未运行的服务。

成功结果的 `data` 包含 `current_version`、`latest_version`、`update_available`、`release_url`、`published_at`、`checked_at`、`cached`、`message`。`checked_at` 是 UTC 时间；`cached=true` 时不是本次联网时间。发现更新时向用户提供返回的发布页面，由用户选择 x64 或 ARM64 安装包，不猜附件 URL。

`latest_version=null` 表示没有可公开访问的正式 Release（也可能是私有仓库），不能将 `update_available=false` 解读为已是最新版。有有效最新版本但没有更新时，也可能是本地开发版本高于发布版。预发布和草稿不会作为更新推荐。

网络、超时、限流及其他 GitHub HTTP 错误返回 `UPDATE_CHECK_FAILED`；无效元数据返回 `UPDATE_RESPONSE_INVALID`，均为 `status=error`、退出 1。失败不使用旧缓存冒充联网结果，不影响现有服务；不反复重试。旧版 CLI 不认识命令时，引导查看[发布页面](https://github.com/OneOFF-ive/saplink/releases)。用户可在受支持的 Windows 安装版中明确选择自动安装。

## 缓存与日志清理

历史审计日志使用 `saplink logs clear --older-than-days 30 --json` 先预览，用户意图包含删除时再加 `--yes`。默认保留 30 天，0 仍保留当天日志。检查 `deleted_files`、`deleted_bytes`、`failed_files` 和退出码，部分失败不应宣称全部成功；不要将审计记录、令牌文件或配置当作普通缓存随意删除。

清理后台连接缓存使用 `saplink cache clear --json`，无需重启服务。检查 `cleared_sessions` 和 `retained_write_requests`；该命令保留写入防重复记录以及全部用户配置。`BUSY` 应等待当前操作结束；`SESSION_NEEDS_REVIEW` 应先核实 SAP 锁；`CACHE_CLEAR_FAILED` 或 `CACHE_CLEAR_UNKNOWN` 不自动重试或重启。UI 持有运行锁时使用其“MCP 服务”页的清理按钮。

## 安全配置连接

```powershell
saplink connection add dev --url https://sap-host:443 --client 001 --username SAPUSER --language EN --password-prompt --json
saplink connection edit dev --language ZH --disable-writes --json
saplink connection test dev --json
saplink connection remove dev --yes --json
```

`--password-prompt` 弹出本机 Windows 密码窗口，密码通过内部管道送入 Windows 凭据管理器，不出现在 AI 命令输出、参数、环境变量或配置文件里。窗口取消、不可用或超时会失败，不保存新密码。新连接及登录地址/Client/用户名变化时必须重新录入密码；未传该选项时，JSON 模式返回 `INTERACTION_REQUIRED`，不会卡在终端询问中。

新连接默认关闭写入，只有显式 `--enable-writes` 才开启；`--disable-writes` 可关闭。删除时 `--yes` 确认删除指定连接及凭据。登录身份不变的语言/写开关修改不需要读取或重新输入密码。旧的无选项交互式 add/edit 在真实终端中继续可用。

连接修改需要 runtime 停止。AI 应记住原端口，停止自己管理的实例后修改，再恢复服务。前台 UI/serve 不会被后台管理器自动关闭。不要在聊天里传密码；无桌面交互环境下应由用户打开原管理 UI 完成凭据录入。

## 后台服务

```powershell
saplink service start --port 8765 --json
saplink service status --json
saplink service restart --json
saplink service stop --json
```

start 要求至少一个 MCP 令牌。后台进程隐藏运行，不依赖发起命令的终端保持打开。重复启动相同端口的已管理实例会返回原状态；更改端口使用 restart 的 `--port`。不指定端口的 restart 保留当前已管理端口，停止状态则默认 8765。

| state | 含义 |
| --- | --- |
| `stopped` | 没有确认存活的 runtime；旧的普通租约可能已过期 |
| `running` | 租约身份匹配，且独立控制接口确认了宿主实例；`mcp_running` 表示 MCP 是否实际运行 |
| `external` | 旧版或独立 UI 等未提供控制接口的进程持有 runtime；管理器不停止它 |
| `unresponsive` | 后台进程身份存在，但控制接口未确认响应；不强杀 |
| `unknown` | 进程身份或锁文件无法确认；先诊断，不自动覆盖 |

还必须检查 `lease.guard_present`。门锁存在时不自动回收；人工恢复流程仍见 [安全说明](security.md)。启动前会实际探测本机 TCP 监听，已有端口不会被接管；探测不是原子预留，实际监听失败仍按错误处理。

stop 通过单独鉴权的 loopback 控制接口请求正常关闭，等待已有请求及 SAP 会话清理。它不调用 taskkill，也不会仅凭 PID 结束其他程序。启动确认最多等待 20 秒，停止确认最多等待 30 秒；返回 `SERVICE_START_UNKNOWN` / `SERVICE_STOP_UNKNOWN` 后必须先查 status，不能盲目重复或强杀。

背景管理不是 Windows Service 安装器，没有承诺开机启动或无人值守崩溃重启。`ui` 与 `serve` 保留前台行为，`--json` 不允许误将它们作为后台命令。

已通过 `service start` 或新版 `serve` 启动时，再打开桌面软件或运行 `ui` 会通过独立认证的本地控制接口复用原宿主。管理 HTTP 与 MCP HTTP 运行在同一个 Node 进程，不重复取得运行锁；桌面托盘及其连接助手不是第二套后端。重复打开复用同一个管理会话，不重启 MCP、不清空请求防重复记录。管理会话 URL 含私密凭据，不写入普通状态输出或日志。

管理页面显示当前共享 MCP 状态，并定期刷新。页面停止 MCP 后保留宿主及管理界面，`service status` 返回 `state=running,mcp_running=false`；可用页面按钮或 `service start` 在原 PID 恢复。`service stop` 和托盘“退出 SapLink 管理”会正常关闭整个宿主及其 MCP、管理监听；关闭浏览器页面不停止服务。旧版本进程不具备接入能力时，不强制接管，应先正常退出并升级。

## 令牌及客户端参数

```powershell
saplink token create --out C:\Users\USER\AppData\Roaming\saplink\client-token.json --json
saplink client-config --token-file C:\Users\USER\AppData\Roaming\saplink\client-token.json --out C:\Users\USER\AppData\Roaming\saplink\connection-parameters.json --json
saplink token revoke TOKEN_ID --json
```

替换示例路径与 ID。父目录需要已存在，输出文件必须是新文件，不覆盖已有文件。JSON 结果只返回 ID/路径，不返回明文令牌。JSON 或被重定向的 token create 必须提供 `--out`；真实交互终端仍可一次性显示令牌。

client-config 验证令牌属于当前配置且尚未撤销，再导出 `transport`、`url`、`headers.Authorization`。这只是产品无关连接参数，不是保证适用于 Codex、WorkBuddy 等所有客户端的完整设置文件；AI 应核对目标客户端已有配置格式，保留其他服务器，并在本地脚本内读写令牌，不打印或上传文件。创建参数文件不代表客户端已成功连接。令牌撤销不会删除已写入文件的副本。

## 一个 skill 完成配置、接入与 SAP 工作

项目附带 [saplink-manager](../skills/saplink-manager/SKILL.md)，面向具有本机终端能力的 AI 客户端。用户要使用产品且确认本机未安装时，Agent 先询问安装意愿并确认安装目录，默认 `~\AppData\Local\Programs\SapLink`；得到同意后优先从 COS、其次从 GitHub 获取官方安装包，官网不再托管或提供安装包更新源，核对架构和完整性后安装。随后负责连接与凭据录入引导、令牌管理、服务启停、给当前客户端配置 `saplink-mcp`、验证 MCP，以及按用户意图执行 SAP 查询或 ABAP 开发。不要求 MCP 预先运行，不通过构建源码替代产品安装。下载、安装和卸载细节见[技能中的产品安装管理](../skills/saplink-manager/references/installation.md)。

将整个技能目录（包括 `references`、`agents`）导入客户端。Codex 默认个人位置为 `%USERPROFILE%\.codex\skills\saplink-manager`，自定义 `CODEX_HOME` 时使用其 skills 目录。用户可以直接说“帮我配置 SapLink 并连接这个 SAP 系统”“查询物料”“修改这个 ABAP 程序”，由 Agent 按需读取配置管理、客户端接入或 SAP 工具说明。不要只分发 SKILL.md 而遗漏引用文件。

客户端新增条目默认名为 `saplink-mcp`，已有同服务条目可复用。Agent 在本机私有文件内转存认证头，合并当前客户端支持的配置，不要求用户复制令牌或手写 TOML/JSON；保留其他服务器及审批策略。Codex 字段及示例见 [客户端接入说明](../skills/saplink-manager/references/client-setup.md)，其他产品需核实其真实配置入口。

分别验证配置写入、MCP 初始化、当前会话工具可见及目标 SAP 操作成功。客户端不支持热加载时可能仍需用户重载或开启新会话；密码仍由用户在本机窗口录入。远程或容器中的 Agent 不能直接通过自身 loopback 连接用户 Windows 服务，不能把这些前提隐瞒为“已全部接入”。

首次安装必须同时取得安装同意和路径确认；卸载只接受用户明确要求，不将其作为连接故障、升级失败或安装损坏的常规修复。安装或卸载失败、部分完成或无法确认时，停止自动操作，报告已知结果并提醒用户手动处理。卸载保留配置、令牌、日志、SAP 凭据和客户端条目，不自动清除个人数据或重装。已安装版本可在用户明确选择后使用 `update install --yes --json` 自动升级，诊断、备份和正常退出仍按升级意图执行，完成后检查版本并恢复客户端接入。连接写开关与 SAP 具体变更遵循用户意图和 SAP 权限。后台托管不等于 Windows Service 或开机自启。
