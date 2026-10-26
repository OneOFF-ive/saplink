# 数据字典、引用与类结构查询

这组工具用于让 AI 先理解 SAP 对象与字段，再分析数据或代码影响。全部为只读工具，不需要开启连接的 `write_enabled`，不保存、激活或执行 ABAP。

先用 `list_connections` 确认系统与三位 Client。`get_capabilities` 的 discovery 仅提供能力线索，不代表授权；具体接口以调用结果为准。

## 工具与输入

下表省略共同的 `connection_id`。列表 `limit` 默认 100、最大 500，没有分页 cursor。树形结果的根节点也占一条额度。

| 工具 | 输入 | 输出用途 |
| --- | --- | --- |
| `get_ddic_definition` | `entity_name`、可选 `field_name`、`limit` | 表、结构或支持的 CDS 实体的字段、类型、长度、主键标志、数据元素与可用标签 |
| `get_data_element` | `data_element_uri` | 数据元素说明、字段标签、类型名称及可用搜索帮助信息 |
| `get_domain_values` | `domain_uri`、`limit` | 域定义、固定值或区间、说明、转换信息和可用值表名称 |
| `find_references` | `object_uri`、可选成对的 `line` / `column`、`limit` | 对象或指定符号的实际引用位置、代码片段及展开状态 |
| `find_definition` | `object_uri`、`line`、`column`、可选 `end_column` / `implementation` | 指定符号的定义位置；`implementation=true` 时定位实现 |
| `get_class_structure` | 类或接口的 `object_uri`、`limit` | 成员名称、类型、可见性和后端提供的静态、常量及只读标志 |
| `get_type_hierarchy` | `object_uri`、`line`、`column`、`direction`、`limit` | 指定类型的上级或下级关系；`direction` 为 `super`（默认）或 `sub` |

除 DDIC 名称查询外，对象 URI 均应来自 `search_objects` 或 SAP 的真实先前结果，不拼接路径。查数据元素时可筛选类型 `DTEL`，查域时用 `DOMA`；类和接口用后端返回的类型与 URI。

## 示例：先理解采购订单字段

```json
{
  "connection_id": "由 list_connections 返回的 UUID",
  "entity_name": "EKKO",
  "field_name": "EBELN",
  "limit": 20
}
```

通过 `get_ddic_definition` 读取字段类型、长度、标签和数据元素名称；再搜索对应数据元素，用 `get_data_element` 读取类型信息。需要解释域编码时，搜索确认域的 URI，然后使用 `get_domain_values`。

指定 `field_name` 时，服务从 SAP 返回的实体元数据中筛选字段，再应用数量限制；不会因为后端返回整表结构而混入其他字段。元数据中未找到字段时返回 `DDIC_FIELD_NOT_FOUND`，不据此断言所有版本中都没有该字段。

域固定值保留原始字符串，例如 `001` 不变成 `1`，区间保留 `low` 和 `high`。固定值不是所有业务有效值；值表也不等于已配置的检查表。工具不会自动读取值表或把域元数据当成业务校验结论。未返回固定值也不代表这个字段没有业务限制。

DDIC 和类结构结果以 `items` 扁平返回；每条的 `parent_index` 指向当前列表中的父节点，根为 `null`。`truncated=true` 表示嵌套结构尚未完整返回；不是只限制根节点的直接子项。

### 结构、INCLUDE 与深层类型

`get_ddic_definition` 首先请求 `/sap/bc/adt/ddic/ddl/elementinfo`。部分 SAP 后端对 DDIC 结构（`TABL/DS`）返回 HTTP 200，但只有空的 `elementInfo`；这不表示结构不存在。遇到空元数据，或该接口返回 HTTP 404/405/500/501 时，工具再按同一实体名请求 `/sap/bc/adt/ddic/elementinfo`。401/403 不触发接口回退；通用接口仍失败时返回其实际错误，不伪造字段。

通用接口结果会校验实体名称，并兼容 XML 命名空间前缀差异。`.INCLUDE` 节点及 SAP 已展开的字段一并返回，`properties.elementProps` 保留后端提供的 `ddicIncludeName`、`ddicIsPartOfInclude`、`ddicIncludeHierarchyLevel`。这些字段表示 INCLUDE 归属，不等于 `parent_index` 的父子层级；后者仅描述本次响应的树形结构。字段过滤与总条数限制同样生效。

Proxy 等深层结构中的表类型成员保留 `ddicDataType=ttyp` 和后端返回的类型引用，不自动递归展开表类型的行结构，也不将类型引用一律视为数据元素。标签取后端可用的短文本；没有返回的长度、标签等信息不会推测补齐。

## 示例：分析类成员和引用

先搜索类，再用 `get_class_structure` 查看活动版本成员。它是后端成员大纲，不承诺包含完整方法签名、全部继承成员或所有调用关系。继承分析使用 `get_type_hierarchy`，不自动递归抓取整个系统。

对象级引用不需要源码坐标：

```json
{
  "connection_id": "由 list_connections 返回的 UUID",
  "object_uri": "由搜索返回的 ADT 对象 URI",
  "limit": 50
}
```

定位某个符号时，先 `read_source(version=active)` 确认位置，再给 `find_references`、`find_definition` 或 `get_type_hierarchy` 提供坐标。行和列均从 **1** 开始，列按 UTF-16 单元计数；`end_column` 是同一行的包含式结束列，不能小于起始列。

工具输入、`find_definition` 的 `target.column` 及继承结果的 `column` 使用从 1 开始的列坐标。类结构链接及引用 URI 中的原始 SAP `#start` / `#end` 片段仍保留 SAP 原生坐标（行从 1 开始、列从 0 开始，结束位置不包含该字符）；不能把片段中的列号直接当作工具输入。

服务端会重新发现并读取活动主源码，校验坐标是否落在有效字符内，再提交给 SAP 分析。`source_context` 返回实际使用的 `source_uri`、`revision` 和坐标；它不包含源码正文，也不是保存源码的授权。源码若已变化，应重读确认，不假设旧位置仍指向原符号。

这组定位工具暂不提供调用者指定的主程序上下文。依赖主程序上下文的 Include、局部类或方法 Include，可能需要另行定位主源码或在 ADT 中复核。

## 覆盖与错误边界

- 接口和对象支持取决于 SAP 版本、权限、仓库索引及服务配置；本地模拟测试不等于目标 SAP 的兼容性认证。
- `truncated` 只反映本次响应的本地数量截断，不保证 SAP 已返回所有引用。where-used 先获取节点，再通过 usageSnippets 分批展开标识；包、类、方法等分组节点以及目标自身声明不计入引用数量。动态调用、生成代码和间接引用仍可能遗漏。
- 空结果不能推导出“没有影响”，继承结果也不是完整调用图。
- 查询使用当前连接的 Client 与语言；不提供跨 Client 参数。
- HTTP 403 保留权限拒绝语义；404 保留未找到语义，不能仅凭一次 404 认定系统不支持整类工具。
- 不会在接口失败后回退执行任意 ABAP、写临时程序或查询敏感系统表。

实现见 `src/repository-query.ts`；MCP schema 与客户端说明通过 `src/tool-definitions.ts` 注册，业务入口由 `src/operations.ts` 调度，复用 `AdtBackend` 的独立无状态 reader。

## 引用展开与部分结果

`find_references.items` 仅列出实际引用位置：`source_uri`、从 1 开始的 `line` / `column`、可用的结束位置、代码片段和 SAP 说明。`end_column_exclusive` 是从 1 开始的、不包含该字符的结束列；它不同于定义定位输入的包含式 `end_column`。`coordinate_scope=fragment` 时，行列属于 SAP 方法/Include 片段，必须结合 `fragment_type`、`fragment_name` 或 `context` 解读，不能当作整个主源码的绝对行；`source` 时属于所列源码。片段和说明分别最多保留 2000 个字符，`snippet_truncated` 标明片段是否被缩短。原始 `matches` 为 SAP 信息，不直接当作用户输入坐标。

`limit` 限制实际引用位置数，不限制返回的分组数。跨组出现的相同位置会去重，目标类自身的类/接口及方法声明不计入引用；真实内部调用仍保留。SAP 的节点 `isResult` 不能单独作为本实现的引用依据：dev 的实际返回中，带可展开标识的调用节点同样可能为 false。

一次调用至多 6 个请求（包含初次查询），每批最多 5 个标识，至多展开 25 个标识。不递归查询调用者的调用者；展开层级固定为“节点 → 引用片段”。请求之间检查 30 秒预算，正在进行的单次请求仍受 HTTP 超时约束，因此总耗时可能超过 30 秒。

检查以下字段，不能只根据工具的 `status=success` 判定全量完成：

- `reference_count` / `returned_count`：本次返回的实际位置数，不是系统全量引用总数。
- `scanned_nodes`、`expanded_groups`、`requests_used`：实际处理范围及请求数量。
- `expansion_complete`：本次 SAP 响应内是否展开完成，不保证仓库索引或动态调用的覆盖完整。
- `truncated`、`truncation_reasons`：位置、请求数、节点数、时间预算或失败造成的不完整。
- `unexpanded_count`、`unexpanded_nodes`：未处理节点及原因；明细最多列 20 条，另有 `unexpanded_nodes_truncated`。
- `errors`：展开失败的脱敏错误。初次节点查询失败仍返回工具错误；后续展开失败保留已取得的位置，同时明确报告部分结果，不自动重放。

没有通用分页 cursor。未展开节点不能解释为无引用，节点空列表也不证明所有动态或间接调用均不存在。


