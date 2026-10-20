# 版本检查与自动升级

适用于已安装 SapLink 的版本维护。首次安装及明确请求的卸载按[下载、安装与卸载](installation.md)执行；损坏修复由用户手动完成。源码运行、旧安装版缺少自动更新能力时，不通过拉取源码或运行任意安装脚本替代此流程，也不自动卸载重装。

## 仅检查版本

```powershell
saplink version --json
saplink update check --json
saplink update check --force --json
```

一般检查使用缓存；要求立即重新查询时使用 `--force`。查询不需要 SAP 登录、MCP 令牌或停服，不修改连接及客户端配置。检查退出码、`status` 和 `data`：

- `update_available=true`：报告 `current_version`、`latest_version` 和 `source`。COS 结果使用 `downloads` 中返回的架构、URL 和 SHA-256；GitHub 回退使用返回的 `release_url`。不拼接安装包地址。
- `latest_version` 非空且 `update_available=false`：没有可升级的正式版本；本地版本可能高于发布版本，不降级。
- `latest_version=null`：未取得可用的正式版本信息，不能报告“已是最新版”。
- `cached=true`：说明来自缓存；`checked_at` 是 UTC 检查时间，不能声称刚刚联网确认。
- `UPDATE_CHECK_FAILED` / `UPDATE_RESPONSE_INVALID`：报告未能确认版本及错误原因，不把错误或历史通知当作更新结论，不循环重试。

默认先读取 COS 清单，不可用时回退 `OneOFF-ive/saplink` 的 GitHub 最新正式 Release；不从官网查询或下载安装包。CLI 普通检查缓存 24 小时；新版 UI 和服务启动后重新联网检查，此后每小时刷新。管理页侧栏以红色 New 表示有新版本，不弹提醒窗口，进入后直接显示自动更新操作；无新版本时保留手动检查。旧版本可能仍使用历史检查周期和通知文件，不将其视为当前检测结果。`SAPLINK_AUTO_UPDATE_CHECK=0` 并重启可关闭自动检查，手动检查和安装仍可用。仅查版本时不为此重启程序。

程序只读取安装包清单 latest.json，不将技能清单 skill-latest.json 或官网代理入口配置为更新源。

`SAPLINK_UPDATE_URL` 可指定 HTTPS 清单地址，`github` 表示仅使用 GitHub；只有用户要求更换信任源时才修改。不要向公共更新源发送 SAP 凭据或 MCP 令牌。

## 用户要求自动升级

“有没有新版”“检查更新”只授权查询。检查到新版后，先报告当前版本、目标版本及安装会暂时中断服务，再主动询问：“发现新版本，是否现在自动更新？”等待用户明确同意后才安装，不将沉默视为同意。用户拒绝或选择稍后时保留当前运行状态，不下载或安装。已有“升级到最新版”“立即自动更新”等明确授权时，无需重复询问。

1. 检查当前版本、最新版本及 `status --json`，记录实际配置目录、原服务状态和端口。自动安装仅支持带更新组件的 Windows 安装版；使用已核实安装目录内的启动器。安装架构由程序判断，不凭当前终端架构选择，也不迁移架构。
2. 仅 COS 清单中包含当前安装架构、校验值及更高正式版本时可自动安装。GitHub 回退只支持查询和提供发布页；不得自行下载 GitHub 附件替代内置流程。CLI 只支持最新版本，没有 `--version` 参数；用户指定其他版本时先说明限制。
3. 对 CLI 托管服务或已停止的安装版执行：

   ```powershell
   saplink update install --yes --json
   ```

   命令会重新查询 COS、下载并校验安装包，确认独立更新程序就绪后才正常停服和安装。不要提前停止服务，也不要另外执行安装包。原后台服务按原端口恢复；原本停止的服务保持停止。
4. `external` 可能是管理 UI；通过已有、已授权的管理页面进入“软件更新”；有 New 标记或已检测到新版本时直接选择“立即自动更新”并确认，不要求用户重复检查。没有新版本结果时再点击“检查版本更新”。页面流程恢复原 UI 端口，并仅在原 MCP 已运行时恢复其原端口。CLI 遇到 `SERVICE_NOT_MANAGED`、未知状态或 guard 时，不强制接管；没有可用页面操作能力时按[运行管理](local-management.md#ui-与-mcp-是两种状态)正常退出前台应用，再执行 CLI 流程并说明其恢复范围。

升级保留连接、凭据、令牌及客户端配置；不为升级重建令牌、改写 MCP 别名或更换 URL。需要备份时仅存于本机私有位置，配置备份不包含 Windows 凭据。

## 确认完成及处理失败

CLI 返回成功、`phase=installing` 或 MCP 暂时断开都只代表移交安装，不能报告升级完成。不要因断开重复发起安装；UI 下载期间可查看进度，安装期间等待原入口恢复。

移交后读取实际配置目录下的 `update-install-result.json`；Web 更新状态的 `last_result` 也包含该结果。核对本次目标版本及完成时间，避免把上一次结果当成本次成功。只有 `status=installed` 且重新执行 `saplink version --json` 确认目标版本后，才报告安装完成。再核实原服务状态和端口；任务需要继续使用 SAP 时，按原客户端连接重连，验证工具发现及 `list_connections`。进程已启动不等于 MCP 或 SAP 可用。

- `UPDATE_HASH_MISMATCH`、下载失败或更新程序未就绪：报告具体失败，核实原服务仍可用；不绕过校验执行安装包。
- `UPDATE_VERSION_CHANGED`：清单在确认后变化，重新检查并说明新的目标，再按用户原授权范围处理；不静默更换用户指定版本。
- `UPDATE_ARCHITECTURE_MISSING` / `UPDATE_NOT_INSTALLED`：说明缺少对应架构或安装组件，提供返回的真实下载入口，由用户手动安装。
- `UPDATE_PENDING`：检查已有任务和结果，不重复安装、不删除 pending 文件或运行锁。
- 结果为 `failed` / `unknown`，或无法确认安装程序是否退出：检查结果文件与当前版本、运行状态，报告已知事实；不强杀进程、不自动重试，不承诺已经回滚。超时或版本无法确认时保留“尚未确认完成”的结论。

旧版本不认识 `update check` 或 `update install` 时，说明该版本缺少相应命令，提供已知的[正式发布入口](https://github.com/OneOFF-ive/saplink/releases)，由用户手动更新以获得新能力。技能文档存在这些命令，不代表本机已安装版本也支持。
