# SAP 调用失败诊断与修复（2026-10-27）

## 已确认并修复

DEV Client 810 的 GET /sap/bc/adt/cts/transportrequests 响应超过旧的 4 MiB 上限。Axios 因响应大小中断，旧错误转换隐藏了 ERR_BAD_RESPONSE 和 response_size_limit，最终仅显示 ADT_ERROR。传输列表改用独立 16 MiB 上限，其他接口仍为 4 MiB。超限返回 BACKEND_RESPONSE_TOO_LARGE，不触发会话重建。

传输任务解析也用于保存源码前的校验。旧实现进入校验前就标记 write_dispatched=true，导致校验失败也可能被报告为保存结果未知。现在校验成功、准备提交源码时才更新该标志；校验失败返回 write_dispatched=false、source_save.saved=false。历史保存失败可能经过同一路径，但缺少当时 HTTP 诊断，不能据此断言历史请求一定未发送。

所有工具失败均记录操作 ID、工具、阶段、错误码和字段白名单内的诊断；发生只读会话恢复时保留首次失败诊断。HTTP/网络错误响应附方法、路径（不含查询参数）、耗时、状态码或网络码。原始消息、头、源码、SQL、筛选值及结果数据不进入失败日志。已有历史日志无法补回缺失字段。

## 真实系统只读验证

通过新源码临时 MCP 实例验证，连接关闭写入，未保存、激活或重放历史写入。原安装版未替换。

- DEV 传输列表连续两次成功：02d85373-b9ad-4a7a-8ae3-17cdb72e00f7、5bb643f4-022d-4ef4-9cb1-328c3d0f0197；返回 1 个 workbench target、2 个可修改请求，并将任务 DEVK904229 解析到父请求 DEVK904228。
- 活动版本 ZSLMMR0020 的语法检查存在间歇性失败。早期探测成功并返回 6 条警告；之后两次复查失败：fdff7b9c-d1e2-4801-b83c-9fef01118ac7、f280d24a-c4a5-40f0-848a-39f38bf6b6eb。
- 失败点均为 POST /sap/bc/adt/checkruns，network_code/cause_code=ECONNRESET，耗时分别为 9 ms、8 ms，未取得 HTTP 状态码，已有会话重建重试仍失败。只能确定连接在响应前被重置，尚不能区分 SAP ICM、中间网络设备或客户端连接层。不能将其直接解释为会话过期，也不能宣称已修复。
- 后续应将该路径及失败时间与 SAP ICM/相关代理日志对齐；先确认连接重置来源，不增加源码保存或激活重试。

## 回归

完整项目测试 232 项通过；最后统一日志字段后，相关测试 67 项再次通过。新增覆盖：大于 4 MiB 的 CTS 响应可读、16 MiB 上限保留、普通接口上限不变、清理操作不会覆盖原错误诊断、保存前校验失败不标记已发送、只读失败落日志以及敏感字段不写日志。


## 后续优化：传输定向查询

保存/创建前校验及新建传输的确认，优先读取指定任务或请求详情，不再默认拉取整个用户传输树。MCP 查询工具新增 transport_number；指定编号返回头信息，并明确标记省略对象清单和操作链接。完整列表调用保留原范围，不静默过滤历史或已释放请求。

DEV Client 810 已实测任务 DEVK904229 与父请求 DEVK904228 均可定向读取，operation_id 分别为 a67a79a1-86c7-4628-b22a-ccb7c6655252、62fa0154-59a4-44f7-9207-bb97b38d80e4；客户端结果约 1 KiB、2.4 KiB。SAP 原始任务详情约 2.23 MiB，父请求详情超过 4 MiB，所以合法 CTS 编号详情也采用 16 MiB 有界上限。未进行 SAP 保存或激活。

优化后的完整测试 236 项通过；最后调整校验逻辑后相关 82 项测试通过。兼容回退由模拟后端覆盖，本轮未实测 QAS。


## ZTEST005 真实保存验证

用户授权仅添加测试注释并保存、不激活。DEV Client 810 的 ZTEST005 位于 $TMP，没有未激活草稿，故本次不涉及传输任务列表。源码 PUT /sap/bc/adt/programs/programs/ztest005/source/main 在约 11 ms 后发生 ECONNRESET，保存操作 999b1e8b-0009-4c98-b38c-b90c60bf133c 返回 outcome=unknown、write_dispatched=true；锁清理完成。随后显式读取 inactive 仍为 VERSION_UNAVAILABLE，active revision 与修改前一致。未确认保存成功，未重复提交，也未激活。此次证据说明还存在独立于 CTS 响应大小的真实请求连接重置问题；不能将历史保存失败统一归因于传输列表上限。临时 MCP 实例已正常关闭。


## 依赖及 HTTP 对照与语法检查修复

对照 abap-adt-api 8.5.0 的请求实现（上游：https://github.com/marcellourbani/abap-adt-api/blob/master/src/api/syntax.ts），其 syntaxCheck 总是内嵌 Base64 源码。DEV ZTEST005 的小请求在原实现、关闭连接复用、显式 Content-Length、标准 Content-Type 和原生 Node HTTP 下均成功；同一 ZSLMMR0020 的 inline 请求在这些变体中均出现连接重置。原请求体 4343 字节；给小程序补空白到 4195 字节仍成功，故不能直接归为统一请求大小上限。改为按保存的版本 URI 检查则成功，返回原有 6 条警告。

源码已改为引用 SAP 中已保存的指定版本，检查前后读取同一版本以确认 revision 稳定。新源码实测语法检查操作 c502c987-80f9-4162-8267-065163089d98 成功，无错误、6 条警告。完整回归 243 项通过；最后补充网络诊断后相关 78 项通过。未升级或直接改写 node_modules 依赖。

对 ZTEST005 的一次受控原生 HTTP 保存对照（082ae7e6-2880-4f99-a8e6-7fc8d2af0797）仍发生 read ECONNRESET。读回 inactive 不存在、active 未变，锁已清理，未激活。对照脚本仅替换 PUT 传输实现，未更新原 transport 的诊断缓存，因此该对照输出附带的 POST/200 诊断是旧锁请求的元数据，不是 PUT 返回 HTTP 200；不应据此推断 SAP 保存成功。

用户确认 Eclipse 可正常保存。Windows 当前没有已打开的 Eclipse，无法直接读取其通信记录；已请求成功保存的脱敏请求行及 Content-Type、Content-Length、Content-Encoding、Accept，以对照目标端点、参数和报文。保存问题仍待定位，不能因语法检查修复而宣称保存修复完成。


## Eclipse 成功保存记录对照

用户打开 Windows Eclipse 后，直接读取 ABAP Communication Log 的成功保存记录：09:45:55.576，PUT /sap/bc/adt/programs/programs/ztest005/source/main?lockHandle=[REDACTED]，返回 HTTP/1.1 200 OK。Content-Type 为 text/plain; charset=utf-8，与 SapLink 一致。未复制锁句柄、Cookie、CSRF token 或认证头。

Destination Properties 显示 jco.client.ashost=10.193.196.2、jco.client.client=810、jco.client.sysnr=00。Stack Trace (Request) 包含 com.sap.adt.communication.internal.jco.dispatcher.JCoRequestDispatcher.dispatch，证明这次 Eclipse 保存通过 JCo 通信分发；不能仅凭日志中的 REST 路径和 HTTP 风格状态行，将其与 SapLink 的 HTTP 8000 端口请求视为相同网络链路。

因此，Eclipse 成功保存不排除 HTTP 通道上的 SAP ICM/网络中间层或 HTTP 处理兼容问题。原生 HTTP 对照也发生连接重置，目前没有足够证据证明替换 abap-adt-api 或 Axios 能修复保存；不据此修改依赖版本。需要在失败时间点核对 HTTP/ICM 连接日志，或取得同一 HTTP 通道的成功请求做进一步对照。

读取时 Eclipse 标题显示 ZTEST005 为 inactive、locked，表示用户当前持有编辑草稿和锁。本轮只查看通信记录，未修改/激活/解锁该 Eclipse 编辑器。


## 用户提供 traces.zip 的 ICM 证据

读取 C:/Users/wzh/Desktop/traces.zip 中 dev_icm（33,876,358 字节、430,273 行），只输出脱敏摘要，未解压/提交原始日志。

- 09:31:07，ICM 请求 89/1129215/6，POST /sap/bc/adt/checkruns，Content-Length=4343；最终只收到 3767 字节，报 connection closed prematurely by client、ICMENIERROR。位置：dev_icm 第 134466、134479、134548–134549 行。
- 同一连接前后总共收到 4380 字节（含 HTTP 头），NiIRead 的 SI_ECONN_BROKEN/104 显示连接重置；客户端同时报 ECONNRESET。位置：第 134521–134526 行。09:33:51 的重复样本同样是接收不完整后断开。
- 原语法检查改为按保存版本引用后实测成功，避免再次上传整份 inline 源码。这是已验证的兼容处理，不能据此断言网络重置根因已消除。
- 本地保存审计时间分别为 UTC 01:24:11.426、01:36:18.939（UTC+8 为 09:24:11.426、09:36:18.939），落在这份跟踪范围内。但全文没有匹配到 ADT PUT 请求行或对应 PUT 原始起始字节；能看到相邻的 GET/锁与清理请求。此证据说明样本未记录到保存 PUT 进入 ICM HTTP 解析，不足以判断是客户端发送层还是中间网络设备终止；不能归因于 ABAP 保存处理器。
- 应核查源端 10.24.193.68 到 10.193.196.2:8000 的 HTTP PUT 及 POST 上传链路，结合客户端/服务端抓包确认 RST 的发起位置，并对照代理/防火墙日志；不通过改请求分片或编码来绕过安全策略。

最终完整项目测试 244 项通过。保存故障尚未修复，没有进行额外保存或激活。


## 历史提交对照 df716319

用户提供 2026-10-14 的 df7163198400d3c2d83c324c939682b387b2b1d2 作为曾成功保存的基线。提取该提交的 Backend 实现，在当前依赖、运行时及 MCP 操作层中与当前 Backend 做同 DEV 对照（不是旧安装包或完整旧依赖复现）。两者读取 ZTEST005 活动源码均成功且 revision 一致，活动版本语法检查均成功。静态比较显示源码 PUT 仍调用 setObjectSource，HTTP 主参数（认证、body、15 秒超时、2 MiB 请求体上限、不重定向）一致；后续较大变化包括独立 reader 会话和 CTS 校验。当前证据不足以认定具体回归提交。

拟使用历史 Backend 验证已授权测试注释，但提交前发现 ZTEST005 已有未激活草稿，故未发送更新请求。随后两个实现均确认同一个 inactive revision 3e7d937a255e3a4800653fd0b10f5801f82cee5fa7472169ca4befafa2b13ed8；active revision 仍为 612edc9da9770edd71c742a261706297489622c4ff51c01c9e093e03e1919dee。无法确认草稿由何处产生，未覆盖、未激活。


## 用户激活草稿后的历史保存重试

用户明确要求再次测试。重新读取确认 DEV ZTEST005 无 inactive，当前 active revision 为 9f67a0fa64bc0869ffc5bb3ef65b36be53024ef7344ade72c90e856a3e433e57。使用 df716319 Backend（当前依赖/运行时/Operations）提交单行测试注释一次，保存 operation_id=0dac0a32-af8e-424f-9b62-db3bfcf802a6，返回 OUTCOME_UNKNOWN、write_dispatched=true，完成锁清理。旧实现未附 HTTP 诊断，不能仅凭该结果断言具体网络码。随后读取 inactive 仍不可用，active revision 与重试前一致。未重复提交、未激活。此结果说明仅回退 Backend 保存实现未解决当前环境中的失败；仍不能排除运行时、依赖或外部 HTTP/SAP 环境因素。


## 历史成功审计记录核实

用户指出以前已成功修改源码后，检查旧产品审计日志 C:/Users/wzh/AppData/Local/sap-mcp/logs/operations-2026-10-14-0.jsonl，确认 update_source 操作 dbf22a7c-f0fb-427e-9374-bbf4b592e8c4，目标 /sap/bc/adt/programs/programs/ztest005/source/main，于 UTC 09:04:50（UTC+8 17:04:50）完成 started、version_checked、saved、verified、lock_cleanup_finished，未记录失败。另有 ZTEST006、ZTEST007 及函数模块的保存并验证成功记录。这是真实操作审计，不是本地模拟测试。

旧日志连接 ID 为 f0d7389e-282a-425d-9051-f78c9852ac28，与当前 DEV 连接不同，旧默认配置文件已不在原位置，因此尚未核实当时确切 URL、Client 和完整运行环境。历史 df716319 的 package.json 已使用 abap-adt-api 8.5.0 和 axios 1.20.0，与当前声明一致；这不等于完整依赖树、Node 版本及部署环境均相同。

结论修正：不能根据当前 ICM 的接收中断直接认定网络设备为根因，也不能仅根据依赖声明相同排除客户端回归。下一步应优先还原成功时的完整运行环境与连接配置，再在同一目标上做受控对照，分别检查代码/会话、依赖锁文件、Node/打包运行时和外部链路变化。仅复用历史 Backend 加当前依赖与 Operations，不足以代表完整旧版本复现。
