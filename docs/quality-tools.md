# ATC、ABAP Unit 与源码版本差异

以运行时 `tools/list` 为准。这组工具不自动保存、激活、恢复源码或释放传输请求；目标 SAP 的接口、权限和系统设置决定实际支持。

## 工具与权限

共同参数为 `connection_id`，必须先通过 `list_connections` 选定系统与三位 Client。对象 URI 从 SAP 搜索或真实先前结果获取，不能将包、集合或 `source/main` 当作单对象执行范围。

| 工具 | 主要输入 | 执行边界 |
| --- | --- | --- |
| `get_atc_configuration` | 无其他参数 | 只读获取 ATC customizing 和默认变式线索，不创建 worklist |
| `run_atc` | `object_uri`、`check_variant`、`max_findings`、`confirm_execution`、`request_id` | 为单个对象创建 ATC worklist 并运行检查；需要开启写入 |
| `get_atc_results` | `run_id`、`limit` | 只读获取现有结果，默认显示最多 100 条、最大 500 条 |
| `run_unit_tests` | `object_uri`、`max_duration`、`limit`、`confirm_execution`、`request_id` | 对单个对象执行 ABAP Unit；需要开启写入 |
| `list_source_versions` | `object_uri`、`limit` | 只读列出主源码历史版本，返回不透明 `version_id` |
| `compare_source_versions` | `object_uri`、`from_version`、`to_version`、`context_lines`、`max_diff_lines` | 只读比较主源码快照 |

`run_atc` 和 `run_unit_tests` 都是执行操作，MCP annotations 不声明为只读或可任意重放。Agent 必须先得到用户针对目标对象的执行授权，才能传 `confirm_execution=true`；不能在普通查询之后自行运行。连接 `write_enabled=false` 时拒绝执行，不自动修改开关。读取配置、结果和版本仍可在只读连接上进行。

每次明确执行使用唯一 `request_id`。相同 ID 与相同参数只获取当前进程的缓存结果，不是重新执行；大结果可能返回 `CACHED_DETAILS_OMITTED`。同 ID 不同参数会冲突。服务重启不保留防重复索引，不能保证跨重启只执行一次。

超时、取消或网络断开不保证 SAP 停止检查或测试。`outcome=unknown` 或 `write_dispatched=true` 后出错时，先核查后端状态，不能换 ID 盲目重跑。执行前记录审计事件；日志不可用时阻止执行，结果不记录源码、测试片段或凭据。

## ATC 流程

1. 调用 `get_atc_configuration` 查看实际配置，再选择管理员提供或已核实的 `check_variant`。配置返回值不是完整变式目录，也不代表拥有执行权限。
2. 用户授权单对象检查后，调用 `run_atc`。`max_findings` 默认 100、最大 500，对应本次请求的 verdict 上限。
3. 检查返回的 `run_id`、`submission`、`infos` 以及 `next_action`，调用 `get_atc_results`。
4. 根据本次检查的范围、变式、优先级、诊断及覆盖限制评估，不把接口成功等同于代码通过质量门禁。

执行示例（占位值需替换）：

```json
{
  "connection_id": "由 list_connections 返回的 UUID",
  "object_uri": "由 SAP 搜索返回的对象 URI",
  "check_variant": "已核实的检查变式",
  "max_findings": 100,
  "confirm_execution": true,
  "request_id": "一次明确检查的唯一标识"
}
```

ATC 建立 worklist 和启动检查是两个后端 POST。中途失败时会尽可能返回 `worklist_id` 与脱敏原因，执行结果标为未知，不自动重放。`submission=accepted` 不是完成或通过证明。

结果按 finding 扁平返回对象、包、优先级、检查、消息和 SAP 原生位置。`object_set_complete` 仅指 SAP 对对象集的描述，不是执行完成状态。当前保守报告 `execution_status=unknown`；`assessment` 为 `findings_present` 或 `no_findings_reported`，不提供无依据的全绿结论。`findings_may_be_limited=true` 提醒还需考虑创建时上限、权限及后端返回范围。没有自动轮询、豁免申请、自动修复或发布动作。

## ABAP Unit 流程

测试会执行 SAP 后端代码，不能按普通源码查询处理。当前仅发送 HARMLESS 风险选择，默认 SHORT 时长类别；`max_duration=medium` 或 `long` 会在用户明确选择时包含相应及更短类别。不会执行 DANGEROUS/CRITICAL 选择，也不扩展到整个包或关联的其他对象测试。

HARMLESS 是 SAP 测试声明和管理设置，不是 SapLink 能独立保证的沙箱。风险等级与时长类别的含义见 [SAP 测试属性说明](https://help.sap.com/docs/abap-cloud/abap-keywords-standard-abap/ABAPCLASS_FOR_TESTING.html)。时长类别不等于本机 HTTP 超时，服务仍使用有界 HTTP 请求。

`status=success` 说明拿到了可解析的执行响应。测试结论必须看 `data.test_status`：

| 值 | 含义 |
| --- | --- |
| `passed` | 返回的方法有明确执行时间证据，未发现失败、未执行状态或警告 |
| `failed` | 发现失败断言、异常、严重警报或后端显式失败状态 |
| `no_tests` | 没有返回测试方法，不算通过 |
| `unknown` | 返回了跳过、未执行、取消或无法确认的状态，或风险选择与返回不一致 |
| `warning` | 方法有执行证据，但存在警告；不报告为全部通过 |

根、程序、测试类和方法级警报都会参与汇总。显示 `limit` 不会隐藏汇总中的失败；只展示前 1 个方法时，后面未显示的失败仍使本次结论为 failed。返回总方法数、已执行数、跳过数、警报和截断状态；方法与警报详情有数量和文本长度限制。

分析会话与持有编辑锁的会话隔离，并禁用 ADT 客户端对执行会话的隐式登录错误重放。不会调用通用运行类、执行函数或保存临时程序来代替 Unit。

## 历史与差异

`list_source_versions` 从对象元数据发现主源码版本历史，以 Atom feed 读取。结果包含标题、日期、作者及 `version_id`；该 ID 绑定连接、对象和发现的历史资源。最多检查 500 个历史条目；后端还有下一页或超过限制时会标记 `truncated`，没有通用分页 cursor。

`compare_source_versions` 默认比较 `active → inactive`，也可将任意一侧替换为该对象的历史 `version_id`。比较历史版本时会重新获取本对象的历史，确认 ID 仍存在，再读取发现的源码资源；不接受调用者提供任意下载地址，不跟随其他域名、非 ADT 路径或 Client 覆盖参数。

历史编号、传输号和版本标题不等于 ADT 主源码的 `version` 参数。当前支持主源码的 plain-text 历史资源；SAP 返回其他格式或未提供版本链接时明确报告限制，不把 XML 元数据当成 ABAP 源码。

非活动版本缺失或取不到时返回错误，不静默换成活动版本。两个版本通过独立读取获得，不是 SAP 原子快照；每侧的 `hash` 用于追溯，活动/非活动读取另有 `read_revision`。历史内容 hash 不可当作 `update_source.expected_revision`；编辑仍需通过 `read_source` 读取和审阅确切版本。

差异为按行分组的 hunks，包含 context / added / removed、双方行号和文本。CRLF/LF 差异会明确标记 `line_endings_only`，不在没有提示的情况下声称两个源码字节相同。

计算和输出限制：

- 单侧源码最多 1 MiB，总行数最多 40000，LCS 计算最多 400 万单元；超过时返回 `DIFF_TOO_LARGE`，不生成假的空差异。
- `context_lines` 默认 3、范围 0–10；`max_diff_lines` 默认 400、最大 2000。
- 差异输出最多约 64 KiB，每行最多展示 4000 个字符；`truncated` 或 `text_truncated` 时不能当作完整补丁。
- 仅比较主源码，不递归遍历类辅助 Include、函数组全部成员、其他对象或整个包；没有自动回滚、恢复或保存。

## 验证范围

本地测试覆盖 ATC 的 worklist/run/结果协议、Unit 风险和时长 XML、401 后不重放执行、权限/确认/审计和请求去重，以及历史链接、差异重建、截断和预算限制。模拟测试不替代真实 SAP 的兼容性认证。

2026-10-24 在开发环境完成了 ATC 配置、主源码历史列表和历史/活动源码比较的只读验证，并修复类 includes/main/versions 相对链接的解析。该链接以类对象文档为基准，不以 source/main 为基准。没有对真实 SAP 执行 ATC 或 Unit；执行链路目前完成本地模拟验证，正式使用前仍应在指定对象上核实后端能力和权限。
