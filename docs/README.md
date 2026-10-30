# SapLink 文档导航

文档依据本仓库实现；目标系统支持范围由 SAP 版本、服务配置及用户权限决定。各版本的下载与变更记录见 [GitHub Releases](https://github.com/OneOFF-ive/saplink/releases)。

| 读者或目标 | 入口 |
| --- | --- |
| 了解产品与主要能力 | [SapLink 产品介绍](../README.md) |
| 安装应用、首次打开与升级卸载 | [Windows 安装指南](windows-installer.md) |
| 检查新版本与用户确认安装 | [版本检查](operations.md#检查新版本)、[确认安装](operations.md#用户确认的自动安装) |
| 代码质量、测试与历史差异 | [ATC、Unit 与源码版本差异](quality-tools.md) |
| AI 默认通过 CLI 和技能使用 SAP | [CLI 客户端指南](cli-client-guide.md) |
| 自行配置可选 MCP 入口 | [MCP 客户端 SAP 操作手册](mcp-client-guide.md) |
| 管理连接、令牌、服务与日志 | [部署与运维手册](operations.md) |
| 管理宿主、MCP、令牌与 CLI 工作流 | [AI 终端管理](ai-management.md) |
| 查询技能支持的全部公开 CLI 命令 | [技能命令目录](../skills/saplink-manager/references/commands.md) |
| 理解模块、会话、锁和版本保护 | [架构文档](architecture.md) |
| 配置可选的 RFC/JCo 传输与验证范围 | [ADT over RFC](rfc-transport.md) |
| 运行源码、测试与构建安装包 | [开发与构建指南](development.md) |
| 本地发布、Actions 暂停/恢复及 COS 同步 | [发布与 GitHub Actions](releases-and-actions.md) |
| 了解安全边界与异常锁文件恢复 | [安全说明](security.md) |
| 开发者查阅接口与实现细节 | [技术参考](technical-reference.md) |
| 下载安装包与查看版本变更 | [GitHub Releases](https://github.com/OneOFF-ive/saplink/releases) |

产品名称统一为 SapLink，CLI 使用 saplink。配置目录和安装标识详见 [命名与本地数据说明](local-data.md)。

## 文档维护范围

仓库文档保留产品说明、操作指南、接口契约、架构、安全边界和开发构建说明，不收录按日期或操作 ID 编写的运行、联调、排障与开发过程记录。通用排障方法可整理到运维或技术参考；正式版本变更集中在 GitHub Releases。

## 建议阅读顺序

普通用户先按安装指南安装，在默认“连接配置”首页添加并测试 SAP 连接，再将 SapLink 技能导入支持本机命令的 AI 客户端，通过 CLI 使用 SAP。MCP 及访问令牌留作可选进阶功能。运维手册统一使用安装后的 `saplink` 命令，不要求下载源码。agent 阅读客户端操作手册，按任务选择流程。开发者从开发与构建指南开始，再查阅架构和技术参考。

文档内连接 ID、对象 URI、revision、传输任务和令牌示例均不是现成环境配置；真实调用必须使用运行结果。安装和模拟测试通过不代表真实 SAP 联调通过。

## 仓库语义查询

[数据字典、引用与类结构查询](repository-query.md)：字段定义、数据元素、域固定值、where-used、定义定位和 OO 结构的参数、示例与覆盖边界。
