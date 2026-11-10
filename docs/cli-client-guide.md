# AI 通过 CLI 使用 SAP

SapLink 默认通过 CLI 和 SapLink 技能供 AI 使用。支持执行本机命令的 AI 客户端可以直接调用 `saplink`，无需创建 MCP 令牌、启动 MCP 服务或编辑 MCP 配置。MCP 保留为供愿意自行研究接入的用户开放的额外功能。两者共用已保存的 SAP 连接、Windows 凭据、SAP 操作层和写入策略。

业务用户仍通过本机管理页面添加、测试 SAP 连接，密码仅在本机输入。安装后确认终端能运行 `saplink version`；安装时未加入 PATH 的，可以使用安装目录中的命令完整路径。新安装后可能需要重启 AI 客户端，使其获得更新后的 PATH。

CLI 模式要求 AI 客户端具有本机命令执行能力；只有聊天功能、无法执行本机命令的客户端不能直接使用此入口。客户端自身的命令审批策略仍然生效。

## AI 客户端找不到 saplink 命令

先在安装 SapLink 的 Windows 电脑上，用同一用户打开 PowerShell，运行 `saplink version --json`。

- **本机能运行，AI 客户端找不到**。如果客户端在同一台电脑、同一用户下运行，可以让它使用已核实的 `bin\saplink.exe` 完整路径。启动器自带 Node.js，系统 PATH 无需包含 `node`。启动器失败且权限允许时，可以用同一安装目录的 `runtime\node.exe` 直接运行 `app\dist\cli.js`，先用 `version --json` 验证。具体命令见[技能的 CLI 接入说明](../skills/saplink-manager/references/cli-setup.md#使用安装包自带的-nodejs)。若沙箱限制执行或凭据访问，使用客户端提供的本机执行权限机制。
- **AI 客户端在云端或容器中运行**。沙箱中的 PATH 与本机安装无关。客户端已有可达、获准使用的 SapLink MCP 时，可以用它访问 SAP。默认 MCP 地址只在 SapLink 所在主机的回环接口可用，云端的 `127.0.0.1` 指向云端运行环境。没有可用的本机执行或 MCP 入口时，可以在 SapLink 的「工作空间」使用内置助手。

只有在用户本机确认安装缺失后，才需要安装。客户端报命令不存在时，先核实执行位置和权限。

如果安装在自定义目录，从当前 Windows 用户的 `HKCU\Software\SapLink` 中读取 `InstallDir`，缺失时查卸载登记的 `InstallLocation`。从核实后的目录查找启动器和自带的 Node.js，详见[安装路径核对](../skills/saplink-manager/references/installation.md#先确认安装是否真的缺失)。

## 业务用户怎样开始

完成安装后，在默认“连接配置”首页添加、测试 SAP 连接。将完整 [saplink-manager 技能目录](../skills/saplink-manager/SKILL.md)导入支持本机命令的 AI 客户端，再描述业务任务即可；技能通过 CLI 完成操作，不配置 MCP。也可以直接向 AI 客户端说明：

> 使用本机 SapLink CLI 连接 SAP。先运行 `saplink tools instructions --json` 学习操作要求，通过 `saplink sap list_connections --json` 确认目标系统和 Client，再查询我需要的数据。操作参数通过 JSON 文件或标准输入传递。不要配置 MCP。

用户描述业务任务，AI 负责命令调用。多个连接的目标有歧义时，AI 应先确认目标系统及三位 Client，不得根据连接名称猜测系统用途。

## AI 的调用流程

```text
AI 客户端 ──执行命令──> saplink sap <operation> ──> SAP 操作层 ──HTTP 或 RFC/JCo──> SAP
AI 客户端 ──MCP──────> SapLink MCP 服务 ────────> 同一 SAP 操作层
```

```powershell
saplink tools instructions --json
saplink tools list --json
saplink tools describe query_table --json
saplink sap list_connections --json
saplink sap get_capabilities --connection <实际连接UUID> --json
```

`tools list` 返回当前版本的完整操作目录、说明和写操作标识。`tools describe <operation>` 返回 JSON Schema，与 MCP 使用同一份参数定义。`saplink sap --help` 也列出所有操作。不需要 SAP 登录即可发现接口。

表数据查询需要在对应连接启用 `allow_table_data`；可在连接配置中开启，或在 MCP 服务停止后使用 `saplink connection edit <连接名称> --enable-table-data`。例如，创建 UTF-8 文件 `query.json`，内容如下：

```json
{
  "table_name": "MARA",
  "fields": ["MATNR", "MTART"],
  "limit": 20
}
```

```powershell
saplink sap query_table --connection <实际连接UUID> --input query.json --json
```

也可通过管道传递一个 JSON 对象：

```powershell
'{"table_name":"MARA","limit":20}' | saplink sap query_table --connection <实际连接UUID> --input - --json
```

需要翻页时，在首次读表的 JSON 中加上 `"pagination": true`。将结果中的 `data.data.next_cursor` 作为下一次输入的 `cursor`，沿用原连接、表、字段和筛选条件。游标为 `null` 表示已到末页。

`query_sql` 使用同样的分页参数。续页提交同一连接和原 SQL，SQL 必须按结果中能唯一标识一行的字符或 NUMC 列排序。

所有操作参数也可以放在输入文件中，包括 `connection_id`。与 `--connection` 同时提供时必须一致。输入上限为 2 MiB；不传 `--input` 时按空对象校验，不会等待终端交互。源码、SQL 和复杂过滤条件建议使用文件或标准输入，避免 shell 引号及转义问题。不要把密码或 MCP 令牌放进输入。

## 管理 SapLink、MCP 与令牌

同一个技能也支持按用户要求管理产品：`app start/stop/status/restart` 控制常驻宿主，`mcp start/stop/status/restart` 仅控制可选 MCP。`app stop` 同时关闭管理页面和 MCP；`mcp stop` 保留宿主和管理页面。二者都不强制终止独立 SAP CLI 进程。`app start` 默认不启用 MCP，宿主重启保留 MCP 原启用状态及端口。

连接、令牌、诊断、更新、缓存和日志命令均保留，完整用法见[技能命令目录](../skills/saplink-manager/references/commands.md)，状态含义和管理流程见 [AI 终端管理](ai-management.md)。默认 SAP 业务任务不会自动启动 MCP 或创建令牌；用户明确要求相应管理操作时，技能再按需执行。旧 `service` 命令仅保留兼容语义，不用它代替“仅停 MCP”。

## 本次调用的超时时间

访问 SAP 的命令接受 `--timeout-ms <毫秒>`，也可以在输入 JSON 中提供数值型 `timeout_ms`。例如对保存后的源码做语法检查：

```powershell
saplink sap syntax_check --connection <实际连接UUID> --input check.json --timeout-ms 60000 --json
```

`check.json` 填入从 SAP 返回的真实 `object_uri` 和 `version`。两个位置同时提供超时时间时必须一致。合法范围为整数 100～600000 毫秒（最长 10 分钟）；不传时保留默认值：HTTP 通常 15 秒，RFC 沿用运行环境设置，RFC CTS 查询默认至少 60 秒。显式参数覆盖这些默认值，包括 CTS 特殊值。

这是本次操作内**每个 SAP 请求**的等待时间，包含登录、元数据、保存及读回校验；不是整个命令的总时限。一个操作可能发出多个请求，总耗时可能更长。参数不会保存到连接、修改环境变量或影响其他调用。本地 `list_connections` 不访问 SAP，不接受此参数。

AI 客户端自身的命令/工具等待时间也需要足够长。延长 SapLink 的等待时间不能覆盖客户端的提前取消，也不能改变 SAP 服务器自己的限制。写操作超时后仍应核实实际状态；更换超时时间不能绕过 CLI 写请求 ID 防重复保护。

### 创建 DDIC 结构和透明表

将参数保存为 JSON 后执行 `saplink sap create_ddic_object --input ddic.json --json`。例如创建一个本地包中的结构：

```json
{
  "connection_id": "11111111-1111-4111-8111-111111111111",
  "ddic_kind": "structure",
  "name": "ZDEMO_ITEM",
  "description": "Example item",
  "package_name": "$TMP",
  "source": "@EndUserText.label : 'Example item'\ndefine structure zdemo_item { item_id : abap.int4; }",
  "request_id": "ddic-demo-item-create-001"
}
```

使用实际连接 ID。创建透明表时将 `ddic_kind` 设为 `table`，提供完整 `DEFINE TABLE` 定义。SAP 要求变更记录时提供实际的 `transport_task`。创建工具保存并核实非活动版本。另行激活时，使用返回的对象 URI 和非活动 revision 调用 `activate_objects`。

## 结果与失败处理

`--json` 输出一个 JSON 对象：

```json
{
  "schema_version": 1,
  "status": "success",
  "data": {
    "operation_id": "...",
    "status": "success",
    "completed_steps": [],
    "data": {}
  }
}
```

外层 `data` 为完整 SAP 操作结果，包含操作 ID、步骤、业务数据及可能的警告。SAP 操作失败时外层 `status` 为 `error`，错误在 `data.error`；参数或本地启动失败时错误在外层 `error`。成功退出码为 0，失败为 1。必须同时检查退出码、状态与详细结果。

CLI 保留 `outcome`、`write_dispatched`、`source_save` 等写入信息；错误不能解释为“SAP 未改变”。保存、语法检查和激活继续分步执行，未知或部分完成的结果先读回 SAP 状态，不能盲目重试。

## 写入、进程与并存

连接只通过 `write_enabled` 决定是否允许写入。可用 `connection edit <name> --enable-writes` 或 `--disable-writes` 设置；没有受控/完全写入之分。

CLI 可独立读取和写入 SAP，不需要启动 SapLink 客户端或 MCP，也不需要模型配置。安全与审批策略由使用者和第三方 AI 客户端自行设置。`approval`、`workflow` 审批命令及公开 `approval_id` 参数已移除；客户端输入框下的受控/完全写入选项不会影响 CLI。

写入仍遵守连接开关、SAP 权限、锁、源码 revision、传输任务与参数校验。CLI 在发出操作前持久保留连接 ID 和 `request_id` 的组合，拒绝包括失败或重启后的重复 ID；标记不是成功证明，不应删除标记来重试。MCP 的请求缓存与 CLI 的持久记录独立；不能通过切换入口盲目重放未知操作。

一次 CLI 调用持有配置锁，结束时关闭 SAP 会话，可与 MCP 并存。配置变更可能暂时返回忙状态。结果不确定时先核对 SAP 与操作日志，再由使用者决定后续操作；不提供跨入口事务或自动回滚。

3.0 源码预览使用 `node scripts/dev-cli.mjs --compiled`（先构建），正式安装版使用其随附的 `saplink`。源码修改不会自动升级已有安装包。
