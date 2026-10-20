# 部署与运维手册

本手册面向已通过安装包安装 SapLink 的用户和管理员。全部 CLI 示例统一使用 `saplink`，可在任意目录的 PowerShell 执行；不需要 npm 或项目源码。源码运行、测试和打包见 [开发与构建指南](development.md)。快捷方式统一显示 SapLink，数据目录见[命名与本地数据](local-data.md)。

安装完成后重新打开终端，使用 `saplink --help` 验证命令是否可用。

## 1. 首次配置与管理界面

先按 [Windows 安装指南](windows-installer.md) 安装，再从桌面或开始菜单打开应用。关闭浏览器只关闭页面；正常退出使用托盘菜单。

页面操作顺序：添加连接 → 测试连接 → 按需要启用写入 → 创建 MCP 令牌 → 启动 MCP。编辑连接前先在页面停止 MCP。管理页面不提供程序编辑或 SAP 业务执行。

管理页面默认端口 8766，MCP 默认端口 8765，两者认证不同。通过快捷方式或托盘重新打开管理页面，不要分享含管理会话凭据的地址，也不要仅输入裸地址替代管理会话。

## 2. CLI 操作

安装后重新打开终端；若由编辑器或 AI 客户端提供终端，重新启动该应用以加载 PATH。\n\n下面 `dev` 是示例连接名称，可替换为英文字母、数字、下划线和连字符组成的唯一名称。

```powershell
saplink connection add dev
saplink connection test dev
saplink connection list
saplink token create
saplink serve --port 8765
```

添加时填写 SAP HTTP/HTTPS 地址、三位 Client、用户名、语言和密码。HTTPS 使用默认 TLS 校验，不接受忽略证书开关，不自动降级。HTTP 明文传输凭据和数据，只在合适的受保护网络使用。SAP 密码由交互提示输入并保存到当前 Windows 用户的凭据管理器。

`serve` 前台运行，Ctrl+C 正常退出。UI 与 CLI 服务不能同时占用同一配置目录的运行锁。CLI 变更连接前停止占用配置目录的 UI/服务；在 UI 内变更时只需先停止其 MCP 子服务。

```powershell
saplink connection edit dev
saplink connection remove dev
saplink token revoke REPLACE_WITH_TOKEN_ID
```

撤销使用创建时返回的令牌 ID，不是令牌明文。令牌可在服务运行时创建或撤销，撤销对后续请求生效。配置改动后客户端应重新列出连接。

## 3. 服务启停与诊断

选择一种运行方式；同一配置目录不能同时由图形管理、后台服务和前台服务占用。

| 运行方式 | 启动 | 正常停止 |
| --- | --- | --- |
| 图形管理 | 桌面或开始菜单快捷方式 | 仅停 MCP 用页面按钮；退出整个应用用托盘菜单 |
| 后台服务 | `saplink service start --port 8765 --json` | `saplink service stop --json` |
| 前台服务 | `saplink serve --port 8765` | 原终端 Ctrl+C |

查看状态、排查本地环境和重启自身管理的后台服务：

```powershell
saplink status --json
saplink doctor --json
saplink service restart --json
```

后台命令只管理自己创建的实例，不会结束前台 UI 或其他进程。切换方式前先正常退出原所有者。更多机器可读参数见 [AI 终端管理](ai-management.md)。

## 检查新版本

检查新版本使用 `saplink update check`，机器可读结果使用 `saplink update check --json`。
命令优先读取 COS 的 `saplink/latest.json`，网络、404 或元数据无效时回退到 GitHub 仓库 `OneOFF-ive/saplink` 的最新正式 Release，显示当前版本、来源及发布下载地址；不下载、不安装，也不停止 SAP 服务。
检查结果在配置目录的 `update-check.json` 中缓存 24 小时，使用 `saplink update check --force` 立即重新查询。
网络失败或 GitHub 限流会报告检查失败，不影响正在运行的服务。没有公开正式 Release（包括仓库为私有的情况）时会明确提示，不能据此判断已是最新版。
`ui`、`serve` 和托管后台服务在启动成功后异步重新查询更新源，之后每小时重新查询一次，不复用 CLI 的 24 小时缓存。程序未运行时不会检查，不创建系统计划任务。管理页可见时每 3 秒刷新检测结果；有新版本时，侧栏“软件更新”显示红色 `New`，点击后直接显示新版本及“立即自动更新”按钮，无需重复检查。没有新版本时保留正常的“检查版本更新”页面。后台检测不弹窗、不再写入 `update-notice.json`，也不会因检测到新版本自动安装。安装仍需用户点击并确认，随后校验安装包、正常关闭并更新。失败时保持运行，下一个周期重试。

设置环境变量 `SAPLINK_AUTO_UPDATE_CHECK=0` 并重新启动应用或服务可关闭自动检查；不影响手动检查和用户确认后的更新。

## 4. 清理连接缓存

管理界面的“MCP 服务”页提供“清理连接缓存”按钮；后台服务可使用 `saplink cache clear --json`。

清理会正常关闭空闲的 SAP 会话，下次查询时重新登录。返回 `cleared_sessions`（清理的会话数）和 `retained_write_requests`（保留的写入防重复记录数）。服务未启动时返回 0；CLI 不操作前台 UI 的缓存，请使用该界面的按钮。此功能无需重启 MCP，也不会删除连接配置、密码、令牌、日志或浏览器管理凭据。

当前没有落盘的查询结果缓存。写操作的 request_id 记录用于防止重复提交，不作为普通缓存删除。正在执行操作、清理中或 SAP 解锁状态异常时会拒绝清理；会话关闭失败会报告失败并保留未确认关闭的会话，不自动重试、重启或绕过锁保护。

## 5. 清理历史日志

在“MCP 服务”页设置保留天数后，点击“清理过期日志”。界面先显示待删除文件数和大小，确认后才永久删除。默认保留 30 天；设为 0 仍保留当天日志。清理按 UTC 日历日期计算，文件日期和最后修改时间都早于保留边界时才符合条件。

```powershell
# 先预览，不删除文件
saplink logs clear --older-than-days 30 --json
# 确认后执行删除
saplink logs clear --older-than-days 30 --yes --json
```

仅处理当前日志目录中符合 `operations-YYYY-MM-DD-序号.jsonl` 格式的历史审计文件，保留当天日志、近期修改的文件、未知文件和子目录，不跟随符号链接或目录联接。不扫描系统临时目录或 npm 缓存。清理不需要停止 MCP，也不更改连接配置、凭据或令牌。

结果包含 `dry_run`、`eligible_files` / `eligible_bytes`、`deleted_files` / `deleted_bytes` 和 `failed_files`。`failed_files` 大于 0 表示存在未能检查或删除的文件，CLI 同时返回非零退出码；不能仅根据顶层 `status=success` 判断全部清理成功。新用户默认目录为 `%LOCALAPPDATA%\saplink\logs`，自定义 `SAPLINK_LOG_DIR` 继续生效。删除前请备份需要保留的审计记录。

## 6. 客户端配置



| 配置项 | 值 |
| --- | --- |
| 传输 | Streamable HTTP |
| URL | `http://127.0.0.1:8765/mcp` |
| HTTP 请求头 | `Authorization: Bearer <创建时得到的令牌>` |

上表是与客户端产品无关的配置字段，不是可直接粘贴的产品配置文件。客户端若不能自定义认证头，不能按当前方式连接；具体格式以该客户端说明为准。端口变更后相应修改 URL。

必须使用 `127.0.0.1`，`localhost` 会被 Host 校验拒绝。MCP 拒绝带 Origin 的浏览器请求；不要把管理页面会话当作 MCP 令牌，也不要通过放宽校验让普通网页直接调用 MCP。客户端操作流程见 [操作手册](mcp-client-guide.md)。

## 7. 文件、权限与备份

| 数据 | 默认位置与行为 |
| --- | --- |
| 配置和令牌哈希 | `%APPDATA%\saplink\config.json`；`SAPLINK_CONFIG_DIR` 可覆盖目录 |
| SAP 密码 | Windows 凭据管理器，按连接 ID 保存 |
| JSONL 日志 | `%LOCALAPPDATA%\saplink\logs`；`SAPLINK_LOG_DIR` 可覆盖目录 |
| 操作去重 | 当前服务进程的内存；退出即清空 |

日志按 UTC 日期和约 5 MiB 大小轮转，不自动删除旧文件；每阶段追加一行，不是源码备份。查询文本、筛选值、数据结果和完整源码不写入操作日志。人工读日志时处理异常退出留下的不完整末行。

备份配置不包含 Windows 凭据；换机器或换 Windows 用户需要重新配置密码。配置包含系统地址、用户名及认证校验信息，应限制访问。不要将本地真实配置、令牌、日志和管理会话 URL 提交到仓库。

连接写入默认关闭；启用后不按包限制，也不按 MCP 令牌区分权限。所有有效令牌共用已配置 SAP 用户的权限，SAP 决定具体对象及数据访问权限。

## 8. 常见故障

| 现象 | 排查与处理 |
| --- | --- |
| HTTP 401 | 核对 MCP Bearer 令牌是否缺失、撤销或混用了管理凭据 |
| HTTP 403 | 核对是否用了 localhost、错误 Host 或携带 Origin；SAP tool 内部 403 需看其错误类别 |
| GET /mcp 返回 405 | 正常：当前没有 GET 事件流，使用支持 POST JSON 响应的 Streamable HTTP 客户端 |
| 无法添加/编辑连接 | 检查 UI/CLI 是否持有运行锁；先正常停止进程 |
| `WRITE_DISABLED` | 经用户授权后由管理员在本地启用该连接写入 |
| `AUTH_FAILED` | 更新 SAP 凭据，重新测试；勿反复重试错误密码 |
| HTTPS 证书错误 | 修复服务器证书或部署受信任的企业 CA，不禁用证书验证 |
| `SESSION_NEEDS_REVIEW` | 核实 SAP 对象锁及在途操作，确认后再重启，不能仅换连接绕过 |
| `LOG_UNAVAILABLE` | 检查日志目录访问权限和磁盘；写入前无法记日志时不会提交业务写入 |
| `REQUEST_LIMIT` | 当前进程最多记录 512 个写请求；核实在途操作后正常重启 |

`runtime.lock.guard` 或 `config.lock.guard` 异常残留的恢复必须遵循 [安全说明](security.md)；不可在其他进程可能运行时删除锁文件。

## 9. 升级与运行验证

升级前停止当前服务并等待在途操作结束，备份需要保留的配置和日志，再按 [安装指南](windows-installer.md) 运行新安装包。不要手工修改连接 ID。

升级后执行：

```powershell
saplink version --json
saplink status --json
saplink doctor --json
saplink connection test dev --json
```

将 dev 替换为实际连接名。doctor 默认只检查本地环境；只有连接测试会访问相应 SAP 系统。诊断结果同时检查进程退出码及 data.healthy，不能只看 status。

随后由客户端验证搜索和源码读取。需要验证写入时，使用明确指定的测试对象和包，按 [客户端手册](mcp-client-guide.md) 完成保存、语法检查、激活和读回，不使用生产变更测试连通性。

双源配置与上传顺序见 [COS 发布流程](development.md#cos-双更新源发布)。默认 COS 地址为 `https://saplink-1302377695.cos.ap-shanghai.myqcloud.com/saplink/latest.json`；`SAPLINK_UPDATE_URL` 可设为自有 HTTPS 清单，或 `github` 仅用 GitHub。缓存按配置的清单 URL 隔离，COS 正常时不额外查询 GitHub。结果新增 `source`（cos/github）与 `downloads`（architecture、url、sha256），管理页面及 CLI 提供按架构的直达链接；未知最新版本仍不可解释为已是最新版。

## 用户确认的自动安装

管理页面左侧的“软件更新”进入独立更新页。未发现新版时提供“检查版本更新”按钮，强制刷新版本信息；后台或手动检测发现更高正式版本后，侧栏显示红色 New，进入后直接显示版本信息与“立即自动更新”，无需再次手动检查。用户确认后才下载 COS 中当前安装架构的安装包。界面显示下载进度，下载失败、SHA-256 不符或更新器预检失败时保持当前应用运行。GitHub 回退只提供发布页，不猜安装包 URL；国内源缺少当前架构时提示手动下载或稍后重试。

自动安装仅支持包含更新助手的 Windows 安装版。源码运行仍可检查版本，但安装按钮不可用。升级前不会直接覆盖正在运行的程序：独立助手先就绪，应用再正常关闭并等待 SAP 操作收尾；助手等待该安装目录下的进程退出，重新核对哈希和安装包产品/版本，然后在原目录静默安装。无强杀进程或删除运行锁。超过等待时间会失败或保留未知状态，不自动再试。

完成后尝试恢复原运行方式：管理 UI 重新打开，原本运行的 MCP 使用原端口启动；CLI 托管服务恢复原端口；原本停止的服务继续停止。配置、Windows 凭据和令牌沿用，不清空。安装失败不承诺自动回滚，必要时使用安装包修复；安装后启动失败应查看结果记录。

CLI 提供相同的显式确认入口：

```powershell
saplink update install --yes --json
```

CLI 在外部 UI/前台服务持有锁时拒绝接管，应在管理页面更新或先正常退出。命令返回“移交更新程序”不是安装成功；最终结果位于配置目录 `update-install-result.json`。下载目录为配置目录下的 `updates/job-*`，默认 `%APPDATA%\saplink\updates\job-随机字符\`；下载时为 `installer.part`，下载及 SHA-256 校验通过后改为 `installer.exe`。`updates/pending.json` 防止重复任务。安装器超时仍可能运行时保留 pending，必须核实后处理，不能删标记盲目重试。成功后尝试删除已执行的 installer.exe；下载失败或校验失败会清除本次 installer.part，其他失败阶段可能保留已下载文件供排查，不应在更新仍进行时删除任务目录。

旧版本不会因为 COS 上传了安装包便自动拥有该功能。首次需要安装包含本次改动的新版本，之后才可从 Web 或 CLI 自动更新。
