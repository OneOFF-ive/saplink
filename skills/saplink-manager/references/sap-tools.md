# SAP 工具使用

开始每项 SAP 查询或 ABAP 开发任务前，先按 [SKILL.md 的服务前置检查](../SKILL.md#访问-sap-前先检查-mcp-服务)核实 MCP 服务；未启动时先正常启动并验证客户端连接、工具发现和 `list_connections`，再访问目标 SAP。只读查询也适用，已有工具名称或历史成功记录不能替代本次服务检查。服务启动失败时先处理并报告阻碍，不直接继续业务请求。同一任务中连接持续可用时不逐工具重复检查。

工具可能带 saplink-mcp、saplink 或其他客户端前缀；以下用协议名称。通过宿主发现真实工具、读取 instructions 和实时 schema，不构造不存在的 CLI 业务命令。

## 选择系统与理解结果

先调用 `list_connections`，核对 `connection_id`、传输方式、目标服务器、三位 Client、用户名及 `write_enabled`；RFC 还需核对系统号和路由，不用兼容 URL 判断真实 HTTP 主机或端口。不凭 dev/prod 名称推断用途；系统或 Client 不明确时确认。除 list_connections 外，其他工具都需要真实 connection_id。

选定目标后可用 `get_capabilities` 探测 ADT discovery；它不授予权限，未声明也不证明绝对不支持。配置接入不需要随意查询业务表。

优先检查 MCP `isError`、`structuredContent`，其次文本 JSON。结果常含 operation_id、status、completed_steps、data 或 error、warnings；参数校验和执行前错误不保证有 operation_id。写操作还看 outcome、write_dispatched、source_save，不能只看 status。保留操作 ID 用于排障，但没有通用“按操作 ID 查询”工具。

## 工具选择

| 目标 | 工具与关键参数 |
| --- | --- |
| 仓库对象搜索 | search_objects(query, type?, limit?) |
| 包浏览 | list_package_objects(package_name, limit?) |
| 读取源码 | read_source(object_uri, version, source_uri?)，version 为 active/inactive |
| 查表或受支持 DDIC/CDS 数据 | query_table(table_name, fields?, filters?, limit?) |
| 联表与聚合 | query_sql(sql, limit?)，单条只读 ABAP SQL SELECT |
| 客户出口/BAdI/增强 | search_enhancements(query, type?, limit?) |
| 创建程序/Include 壳 | create_program(name, description, package_name, program_kind?, transport_task?, request_id) |
| 创建函数组 | create_function_group(name, description, package_name, transport_task?, request_id) |
| 创建空函数模块 | create_function_module(name, description, function_group_uri, transport_task?, request_id) |
| 函数组成员 | list_function_group_members(function_group_uri, limit?) |
| 函数组激活快照 | get_function_group(function_group_uri) |
| 保存源码 | update_source(object_uri? 或 source_uri?, source, expected_revision, transport_task?, request_id) |
| 语法检查 | syntax_check(object_uri, version)，一般检查 inactive |
| 激活 | activate_objects(objects: [{object_uri, expected_revision}], request_id) |
| 查询传输请求及任务 | list_transport_requests |
| 创建新传输请求 | create_transport_request(object_uri, package_name, description, request_id)，仅限用户需要新请求 |

表中省略共同的 connection_id。以实时 schema 为准，不发送未定义字段。当前列表 limit 默认 100、最大 500，批量激活最多 20 个对象，无通用分页 cursor。

## 数据与增强

优先 query_table，只取必需的列、筛选和少量行。filters 为 AND 组合，每项 `{field, operator, value}`；operator 为 eq/ne/gt/ge/lt/le/like，value 保留字符串、不自行加 SQL 引号。LIKE 用 `%`、`_`，不是仓库名称模式的 `*`。

确需联表或聚合才用 query_sql。ABAP SQL 限定字段通常用 `~`；仅单条 SELECT，不加注释、分号、INTO、写入、跨 Client 或 privileged access 子句。不把外部值拼成未经核实的 SQL 语法。limit 限制返回行数，不限制扫描开销；truncated 表示不完整，不能据此声称全量总数。保留前导零、小数精度及原始字符串，不随意转 Number。

search_enhancements 用 `*` 名称模式，type 为 all 或实时 schema 的 SMOD/CMOD/SXSD/SXCI/ENHS/ENHO/ENSC/ENHC。统一查询先 all，再按类别筛选。实现 activation.status 为 active、active_with_inactive_version 或 unknown，定义可能为 not_applicable；结合 activation.probes 和覆盖限制解释。仓库活动版本不代表 BAdI 开关、过滤器或 CMOD 运行时启用，runtime_enabled=unknown 就明确报告未知。空列表不证明系统没有增强。

## ABAP 修改

1. 明确对象、包、变更范围及是否激活。write_enabled=false 时不因查询自动开启；需要开发变更时说明开关影响，在用户要求开启后由本地管理流程修改。
2. object_uri 从搜索、包浏览或真实先前结果获取；source_uri 和 revision 从 read_source 获取，不拼接 /source/main，不猜任务号或 revision。先读取并审阅确切版本。
3. update_source 携带审阅过的 expected_revision。每个明确意图的写操作用独立 request_id，创建、保存、激活分别用不同 ID。同 ID 和参数只返回当前进程缓存，不是重新执行或实时查询。
4. 保存与激活分开，检查 source_save，读取/检查 inactive，处理诊断。VERSION_UNAVAILABLE 时按 next_action 显式读 active，不静默假定两个版本相同。
5. 用户要求激活时，以当前 inactive revision 调用 activate_objects，再读 active 验证。同一授权变更涉及互相依赖的对象时，将它们及各自 revision 放在一次 objects 请求中联合激活，避免逐个激活造成依赖错误。函数组整体激活用 get_function_group 的快照 revision，并核实全部成员属于用户变更范围；组没有可直接保存的主源码。后端返回额外依赖时先核实变更范围，不自动扩展激活对象或反复重试。

创建工具只生成壳，不生成完整接口或自动激活。按返回 next_action 获取真实源码/组快照，继续完成已授权工作。program_kind 为 report/include/module_pool/subroutine_pool；屏幕与 GUI 状态不由本服务生成。函数模块使用 ADT 支持的源码式接口声明，先看运行时工具帮助，不将调用语法或 Local Interface 注释当接口定义。

SAP 要求变更记录时，每次 create/update 显式传确认过的 transport_task，不继承前次任务。$TMP 可省略任务；其他包由 SAP CTS 检查，不仅按包名断言。先查询已有可修改任务，区分父请求与当前用户任务；有歧义再问。仅在用户需要新请求时创建，不自动选择任务或释放请求。

## 错误和维护衔接

- VERSION_CONFLICT：重读、审阅并合并，不能只替换 revision 再覆盖。
- partial、unknown、VERIFY_FAILED 或已 write_dispatched 后出错：核实实际保存、创建、传输或激活状态，不自动换 request_id 重放。
- OBJECT_LOCKED、SESSION_NEEDS_REVIEW、LOCK_CLEANUP_FAILED：报告锁/会话问题及完成阶段，不强制解锁或换连接绕过。
- WRITE_DISABLED、登录或授权错误：区分本地开关、凭据、SAP 权限与 CSRF，在用户授权范围内处理，不反复尝试失败密码。
- REQUEST_LIMIT：当前进程去重容量有限，先核实在途及未知操作，再按维护任务正常重启。重启清空索引，不保证跨重启恰好执行一次。

取消请求或终止客户端不保证 SAP 停止写入；日志不提供事务回滚或源码备份。不支持任意 ABAP 执行、业务数据写入、对象删除、调试或传输释放。只报告已确认结果，能力之外明确说明，不用终端绕过工具限制。
