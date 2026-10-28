# ADT over RFC / JCo

SapLink 提供可选 RFC 传输。MCP 协议、工具名、对象 URI、revision、写入开关和审计仍由现有实现管理。
`AdtBackend` 将同一套 ADT 请求通过 Java/JCo 调用 `SADT_REST_RFC_ENDPOINT`，不开放通用 RFC/BAPI 执行工具。

RFC 运行环境需要兼容的 Java、JCo JAR 和原生库；后端能力与兼容性由目标 SAP 版本、架构及权限决定。

## 连接和运行环境

旧配置不变：没有 `rfc` 字段时继续使用 HTTP/HTTPS。启用 RFC 的连接增加以下非敏感字段：

```json
{
  "rfc": {
    "ashost": "sap-host",
    "sysnr": "00",
    "saprouter": "/H/router.example.com/S/3299"
  }
}
```

`sysnr` 必须恰好两位数字，不能从 HTTP 端口推算。支持应用服务器直连及经 SAProuter 连接；消息服务器负载均衡、SNC/SSO 未配置接入。
`client`、`username`、`language`、`write_enabled` 和 Windows 凭据沿用现有连接。
切换传输方式、更改 RFC 主机、系统号或 SAProuter 路由都要求重新输入密码，不能静默将旧凭据用于新目标。

`saprouter` 可省略或留空，表示直连；设置后通过 `jco.client.saprouter` 传给 JCo，应用服务器仍由 `ashost` 指定。只填写中转节点，例如 `/H/router.example.com/S/3299`，多跳可使用 `/H/outer.example.com/S/3299/H/inner.example.com/S/3299`，不要在末尾重复添加应用服务器。每个 `/H/` 后是主机名或 IPv4 地址，`/S/` 可填写端口或服务名；省略时由 SAProuter 使用默认服务。最多 8 跳、2048 个字符。

配置只接受不带秘密的路由地址，不支持 `/P/`、`/W/` 路由密码或 SNC 路由。它们不能写入普通连接配置。网络管理员仍需在 SAProuter 放行到目标 RFC 服务的连接；配置语法合法不代表路由可达。路由语法见 [SAProuter 官方说明](https://support.sap.com/en/tools/connectivity-tools/saprouter.html)。

RFC 连接不需要 HTTP 地址，也不推算或探测 HTTP 端口。配置中的 `base_url` 仅为兼容旧配置保留；新 RFC 连接使用固定占位值 `http://rfc.invalid`，RFC 后端不会使用它连接或校验返回链接。已有 RFC 连接的该字段保持兼容，修改它不会更换登录身份。

源码历史中，来自已认证 RFC 响应的 HTTP/HTTPS 绝对链接会转换为当前对象范围内的 ADT 相对路径，再通过原 RFC 会话读取。返回的主机别名、HTTPS 或非标准 HTTP 端口不会成为网络访问目标；含凭据、片段、路径穿越、其他对象路径及不允许的查询参数会被拒绝。HTTP 连接仍严格执行同源校验，不受 RFC 规则影响。RFC 失败不会自动切换到 HTTP。

新建 RFC 连接时，可点击“导入本地 SAP Logon 连接”，搜索并选择已有连接，填入应用服务器、系统号和 SAProuter；源配置包含有效 Client 或两位语言代码时一并填入。连接名称、SAP 用户名和密码始终由用户填写。选择连接不会保存配置或登录 SAP，确认后仍需点击表单的保存按钮。

导入读取 `%APPDATA%/SAP/Common/SAPUILandscape.xml` 和 `SAPUILandscapeGlobal.xml`，也支持 `SAPLOGON_LSXML_FILE` 指定的本地文件。仅返回允许导入的连接参数，不返回 Memo、用户名、密码等其他内容，不修改 SAP Logon 配置或访问外部引用。当前支持标准 `32<系统号>` 端口的应用服务器连接及非敏感 SAProuter；消息服务器负载均衡、SNC、自定义端口和外部引用中的连接暂不支持。
输入实际目标系统的 ADT origin 即可，RFC 模式不要求该 HTTP 端口可达。

SAP 密码依然保存在 Windows 凭据管理器。Java 启动参数、环境变量和配置文件不携带密码；Node 仅通过拥有的子进程 stdin 传递凭据。
管道的 base64 用于消息封装，不是加密，也不隔离同一 Windows 用户下的其他进程。

本机运行环境使用绝对路径：

| 环境变量 | 用途 |
| --- | --- |
| `SAPLINK_RFC_JAVA` | `java.exe` 完整路径 |
| `SAPLINK_RFC_JCO_JAR` | 用户合法取得的 JCo JAR |
| `SAPLINK_RFC_NATIVE_DIR` | 包含匹配架构 `sapjco3.dll` 的目录 |
| `SAPLINK_RFC_BRIDGE_CLASSES` | 可选，编译后的自有桥接类目录；默认 `bridge/classes` |
| `SAPLINK_RFC_TIMEOUT_MS` | 可选，单次桥接启动/请求超时，默认 15000，范围 100～120000 毫秒 |

这些设置只用于运行 SapLink 的本机进程。JVM 和原生库必须匹配架构、版本；Windows ARM64 原生 JCo 尚未验证。

x64 安装包自带固定版本的 Eclipse Temurin JRE 17，保留完整法律声明，不安装系统级 Java、不修改 `JAVA_HOME`。Windows ARM64 安装包暂不携带 Java，需使用兼容的本机 JVM/JCo。

在“MCP 服务 → RFC 运行环境”或 RFC 连接表单中的“检查运行环境”打开配置。可以指定 Java 安装目录和包含原始 `sapjco3.jar`、`sapjco3.dll` 的 JCo 目录，留空恢复自动检测。检查会实际启动 JVM 并加载 JCo/JNI，返回 Java/JCo 版本、架构及缺失组件，不登录 SAP。保存路径前需停止 MCP；路径保存在用户配置目录的 `rfc-runtime.json`，不随应用升级或卸载删除。

优先级为界面保存的路径、显式 `SAPLINK_RFC_*` 环境变量、随包 Java、系统 Java。系统检测读取 `JAVA_HOME`、`JRE_HOME`、PATH 和常见 Java 安装目录；JCo 检测读取 `SAPJCO_HOME`、CLASSPATH 以及用户配置目录下的 `jco` 子目录。显式路径无效时会报告错误，不静默换到另一套组件。`doctor` 在配置了 RFC 连接时也会检查本地环境。

SAP 官方禁止再分发 JCo，因此安装包不携带或自动下载 JCo。用户需从 [SAP 官方页面](https://support.sap.com/en/product/connectors/jco.html)取得适合其环境的版本，再指定本地目录。完整条款见 [SAP Connectors](https://support.sap.com/en/product/connectors.html)。HTTP 连接不要求 Java/JCo。

## 从源码构建和配置

安装版使用其自身版本支持的配置，不要将 RFC 配置交给不支持该字段的旧版本读取。开发时使用独立 `SAPLINK_CONFIG_DIR`，通过 CLI 或 Web 连接表单管理配置，不手动复制密码或令牌。

```powershell
npm run build
./bridge/build.ps1 -JavaHome '<本机 JDK 目录>' -JcoJar '<本机 JCo JAR 路径>'
if (!$?) { throw 'Bridge build failed' }

$env:SAPLINK_RFC_JAVA = '<本机 JDK 目录>/bin/java.exe'
$env:SAPLINK_RFC_JCO_JAR = '<本机 JCo JAR 路径>'
$env:SAPLINK_RFC_NATIVE_DIR = '<包含 sapjco3.dll 的目录>'
$env:SAPLINK_CONFIG_DIR = '<独立的开发配置目录>'

node dist/cli.js connection add rfc_test --transport rfc `
  --rfc-ashost sap-host --rfc-sysnr 00 --rfc-saprouter /H/router.example.com/S/3299 --client 001 `
  --username SAPUSER --language EN --password-prompt --json

node dist/cli.js connection test rfc_test --json
```

安装包构建通过 `packaging/windows/build.ps1 -Architecture x64 -RfcBuildJavaHome '<JDK 目录>' -RfcBuildJcoJar '<JCo SDK JAR>'` 编译自有桥接类。SDK 只参与编译，不复制进产品。Temurin 下载 URL 和 SHA-256 固定在 `packaging/windows/download-lock.json`，安装清单覆盖随包 Java 及法律声明。构建会拒绝混入 JCo JAR/DLL 的公开安装包。

新连接默认只读。启用写入仍须用户明确要求并使用现有写入开关。
不经过 SAProuter 时省略 `--rfc-saprouter`。已有 RFC 连接改回直连使用 `connection edit <name> --clear-rfc-saprouter --password-prompt --json`；修改其他字段时默认保留已有路由。
切回 HTTP 可使用 `connection edit <name> --transport http --password-prompt --json`，原 `--http-transport` 仍兼容。不能同时指定 HTTP 与 RFC 参数。
CLI 连接变更仍要求原运行进程释放配置锁；本功能不增加运行时热切换或强制重启。

Web 添加和编辑连接时先选择 HTTP/HTTPS 或 RFC/JCo；RFC 显示应用服务器、系统号及可选 SAProuter 路由，切回 HTTP 后不提交 RFC 参数。交互式 CLI 同样提供连接方式选择。连接列表显示 RFC 目标和是否经 SAProuter，可按主机名或路由地址搜索。
运行环境路径可通过管理页面或本机环境配置；仅接受本机组件目录，不接受任意 Java 命令或 SDK 下载地址。

Windows 安装打包会携带仓库自有 `bridge` 目录；构建者应在打包前编译桥接类。
未编译桥接类或缺少 Java/JCo 时，HTTP 功能不受影响，RFC 首次使用会明确返回运行环境不可用。

## 会话与恢复

- 编辑、只读查询和质量检查各有独立的按需启动 Java 子进程，不共享 JCo destination 实例。
- 编辑/质量通道在同一 Java 主线程持有 `JCoContext`；读取通道无持久 JCo 上下文。
- 每个通道串行发送 ADT 请求。读取会话空闲重建时，只释放并替换读取通道，不更换编辑上下文。
- 登录状态基于 RFC ADT 登录探测成功，不伪造 CSRF token；不传递 HTTP Basic、Cookie 或 CSRF 到 RFC。
- bridge 仅调用 ADT 入口，只接受经过路径校验的 `/sap/bc/adt/` 相对 URI，拒绝外部地址、路径穿越和重定向。
- 会话退出使用 `JCoContext.end` 与子进程退出确认。首次启动失败、登录失败、超时、桥接退出和协议错误都不自动重放请求。
- 请求发出后断线不能证明 SAP 未执行；现有操作层保留 `write_dispatched`、`source_save` 和 `outcome`。锁状态不明时阻止继续写入。

主要错误码：`RFC_RUNTIME_MISSING`、`RFC_RUNTIME_UNAVAILABLE`、`RFC_AUTH_FAILED`、`RFC_LOGIN_FAILED`、`RFC_CONTEXT_LOST`、`RFC_PROTOCOL_ERROR`。
后端正常返回的 ADT 状态和 XML 错误继续走原有分类与脱敏。不会向 MCP 返回 Java 堆栈、JCo 原始错误消息、密码或锁句柄。

## 开发与使用边界

运行 RFC 传输的自动化测试：`node --import tsx --test tests/rfc.test.ts`。完整测试与构建步骤见[开发指南](development.md)。模拟测试不替代目标 SAP 的兼容性核实。

保存、检查和激活沿用公共操作层的写入开关、对象锁、revision 和 request_id 保护。存在依赖的修改应先全部保存，再按[多对象联合激活](mcp-client-guide.md#多对象依赖与联合激活)提交已审阅的集合；不自动扩大依赖范围、回滚或重放未知结果。

桥接的离线路由校验可在编译 `bridge/classes` 后，将 `tests/java/SapLinkRfcBridgeRouterTest.java` 编译到独立测试目录，并以测试目录、桥接目录和本机 JCo JAR 作为 classpath 运行 `SapLinkRfcBridgeRouterTest`。该检查不连接 SAP；真实路由可达性需使用指定连接的连接测试核实。
