# 运行与配置管理

使用已核实的安装版 `saplink`；PATH 未刷新时用启动器绝对路径。不直接改写连接 JSON 或 UUID。

## 状态与诊断

```powershell
saplink version --json
saplink status --json
saplink doctor --json
saplink sap list_connections --json
```

JSON 模式同时检查退出码和 `status`。doctor 的 `status=success` 只说明生成了报告；结合 `data.healthy` 及各检查项判断。CLI 访问 SAP 不需要后台服务或访问令牌，不为满足可选服务的诊断项创建令牌或启动服务。默认诊断不访问 SAP；指定 `doctor --connection <真实名称> --json` 或 `connection test <名称> --json` 才测试登录和 discovery。

## SAP 连接与密码

连接列表确认真实名称、传输方式、目标服务器、Client 和用户名。RFC 使用应用服务器、系统号及路由识别目标，不将兼容字段 `base_url` 当作真实 HTTP 地址。新连接优先 RFC，现有 HTTP 连接保持原方式；按当前版本 `connection add --help` 核实选项。

```powershell
saplink connection add dev --transport rfc --rfc-ashost sap-host --rfc-sysnr 00 --client 001 --username SAPUSER --language ZH --password-prompt --json
```

需要路由时添加 `--rfc-saprouter /H/router.example/S/3299`。仅填中转节点，目标服务器仍由 `--rfc-ashost` 指定；不支持路由密码、SNC/SSO，不把秘密放入路由。改回直连用 `connection edit <name> --clear-rfc-saprouter --password-prompt --json`。RFC 不要求 HTTP 地址，不回退 HTTP。

用户指定 HTTP 时使用 `--transport http --url https://sap-host:443`。地址可带 `/sap/bc/adt`，不能包含其他路径、查询、fragment 或内嵌凭据，不绕过证书校验。

连接名称支持中文、字母、数字、下划线和连字符。后续编辑、测试和删除使用实际完整名称，不自动翻译；中文名称在命令中正确引用。系统号为两位数字，Client 为三位数字并保留前导零。管理页面默认打开“连接配置”，可以从“导入本地连接”选择 SAP Logon 条目填入服务器等信息；不读取 Memo 或密码补齐身份。

完整安装包固定使用随包 Java/JCo，无需用户安装组件或设置环境变量。通过连接表单中的“检查运行环境”检查组件；缺失或损坏时报告诊断并按修复流程处理。源码或旧版本以其实际能力为准，不借用其他软件组件或改全局环境来掩盖产品安装问题。

提前告知会弹出本机密码窗口，由用户输入。密码保存到当前 Windows 用户的凭据管理器，以连接 UUID 索引；不得从聊天、命令参数或环境变量获取。JSON 模式缺密码返回 `INTERACTION_REQUIRED`；取消后不自动重试。

编辑用 `connection edit <name>`。修改登录身份（传输方式、服务器、路由、Client 或用户名）须重新录入密码，仅改语言和写开关不需要。写开关用 `--enable-writes` / `--disable-writes`，仅按用户意图变更。

## 宿主与 MCP 的独立管理

全部命令见[命令目录](commands.md)。`app start/stop/status/restart` 管理常驻宿主，`mcp start/stop/status/restart` 仅管理 MCP；前者的 `--port` 指管理端口，后者指 MCP 端口。`app start` 默认只启动管理监听，不需要令牌；`mcp stop` 保留宿主和界面，`app stop` 关闭宿主及 MCP，不终止独立 CLI SAP 进程。

`ui` 会启动或复用托管宿主，打开默认的连接配置首页；关闭浏览器或 UI 附着命令不会关闭宿主。正常退出用 `app stop` 或托盘退出。重启宿主保留 MCP 原启用状态和端口，不把原本只用 CLI 的环境变为 MCP 模式。用户只要求 SAP 查询时不启动任何宿主。

## 配置锁与正常退出

独立 CLI 业务操作可与管理 UI、可选后台服务并存；单次操作会占用配置锁，另一个调用或配置修改可能暂时返回忙状态。配置增删改还要求 runtime 空闲：正常退出持锁 UI/宿主后修改，完成后只恢复原本的运行方式，不因使用 SAP 而启动额外服务。

必要时用 `app status --json` 核实已有宿主；`running` 且 `managed=true` 才通过 `app stop --json` 正常关闭，完成后检查状态。旧版或未知 UI 使用托盘退出，前台 `serve` 由原终端正常退出。关闭浏览器页面不等于退出宿主；无法正常关闭时说明所需用户动作，不强杀、删锁或接管未知 PID。

仅在用户意图是删除特定连接及其凭据时使用 `connection remove <真实名称> --yes --json`，保留其他连接。

## 本地维护

- `saplink logs clear --older-than-days 30 --json` 先预览；用户要求删除这些日志时才加 `--yes`。0 仍保留当天（UTC）日志，检查 `failed_files`，不报告部分失败为全部完成。
- CLI 调用结束后自行关闭会话。后台缓存清理不是 CLI 接入的前提；用户明确维护已有后台宿主时可用 `cache clear --json`，保留配置、凭据及写请求记录，不为清缓存启动服务。
- CLI 的 `cli-write-requests` 是持久防重复标记，不删除它来重试写入，不当作可清理连接缓存。
- 版本检查与升级见[更新说明](updates.md)，安装修复和卸载见[产品安装管理](installation.md)。
