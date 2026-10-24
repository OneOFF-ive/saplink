<p align="center">
  <img src="packaging/windows/assets/app-icon.png" width="180" alt="SapLink 图标：代表 SAP 与 AI 的两个大圆环，由代表 SapLink 的小圆环连接，共同构成无限符号">
</p>

<h1 align="center">SapLink</h1>

<p align="center">
  <strong>连接 SAP 与 AI，探索无限可能。 ✨</strong>
</p>

<p align="center">
  面向 AI Agent 的本地 SAP ABAP 连接应用
</p>

<p align="center">
  <a href="https://github.com/OneOFF-ive/saplink/releases">⬇️ 下载与发布说明</a> ·
  <a href="docs/windows-installer.md">📦 安装指南</a> ·
  <a href="docs/mcp-client-guide.md">📖 客户端手册</a> ·
  <a href="docs/README.md">📚 全部文档</a>
</p>

---

## 🔗 让 SAP 能力进入 AI 工作流

SapLink 将 SAP 中的源码、开发对象和数据查询能力，通过 MCP 提供给 AI 客户端。你可以在熟悉的 AI 工作环境中阅读和分析 ABAP、创建与修改程序，并完成语法检查和激活。

应用独立运行，不依赖 VS Code 或 SAP GUI。通过本地管理界面配置 SAP 连接后，支持 Streamable HTTP 的 MCP 客户端即可接入。

## ♾️ 三环相连，无限可能

SapLink 的图标由三个相扣的圆环构成：左右两个大圆环代表 **SAP** 与 **AI**，中间的小圆环代表 **SapLink**，将两者连接起来。

三个圆环共同构成一个无限符号，寄托着产品的愿景：让 SAP 的企业能力与 AI 的创造力相遇，探索 **SAP + AI 的无限可能**。

## 🧩 能做什么

| 场景 | SapLink 提供的能力 |
| --- | --- |
| 🔍 理解现有代码 | 搜索仓库对象、浏览开发包、读取活动源码和未激活草稿 |
| 🛠️ 辅助 ABAP 开发 | 创建 Program、Include、函数组和函数模块，修改主源码、检查语法并显式激活 |
| 📊 查询 SAP 数据 | 读取表及后端支持的 DDIC/CDS 实体，执行只读 ABAP SQL 关联与聚合查询 |
| 🧭 查找客户增强 | 搜索客户出口、BAdI 和增强容器，查看可获取的仓库版本状态 |
| ⚙️ 管理开发连接 | 管理多个 SAP 系统连接、访问令牌和服务状态，支持 Web 界面与 CLI |
| 🤖 配合 AI 工作流 | 提供工具描述、操作指引、版本保护和失败状态，帮助 agent 按步骤完成任务 |

例如，你可以让 agent 查找某个程序并解释其逻辑，在指定测试包中创建一个 REPORT，或查询物料数据并按类型汇总。具体可用能力取决于目标 SAP 系统与用户权限。

## 🚀 四步开始

```text
AI 客户端 → SapLink 本地 MCP 服务 → SAP ADT → SAP ABAP 系统
```

1. **下载并安装**：通过 [官网下载入口](https://saplink.cloud/download.html)从 COS 获取适合本机架构的 Windows 安装包，或使用 [GitHub Releases](https://github.com/OneOFF-ive/saplink/releases)，安装后通过快捷方式打开管理页面。安装包内置运行环境，无需另装 Node.js。
2. **添加 SAP 连接**：输入 ADT 地址、Client、用户名和语言，在本机填写密码并测试连接。
3. **接入 AI 客户端**：创建访问令牌、启动 MCP，将服务地址与令牌配置到客户端。
4. **开始操作**：让 agent 先确认目标系统，再按任务读取、查询或执行已授权的开发变更。

当前支持 64 位 Windows 10 1809+ / Windows 11，提供 x64 与 ARM64 安装方式。SAP 侧需要启用并可访问 ADT；AI 客户端需要支持 Streamable HTTP 和 Bearer 认证头。

| 你的电脑 | 选择安装包 |
| --- | --- |
| Intel / AMD 64 位 Windows 电脑 | 文件名包含 `win-x64` 的 `.exe` |
| Windows ARM64 电脑 | 文件名包含 `win-arm64` 的 `.exe` |

完整步骤见 [Windows 安装指南](docs/windows-installer.md) 与 [部署与运维手册](docs/operations.md)。从源码运行与制作安装包见 [开发与构建指南](docs/development.md)。

应用启动时检查新版本，运行期间每小时刷新；发现新版后侧栏“软件更新”显示红色 New，不弹窗。也可运行 `saplink update check` 手动检查。支持的 Windows 安装版可在用户确认后下载、校验并安装更新，不会未经确认自行升级。详细步骤见 [版本检查](docs/operations.md#检查新版本) 与 [用户确认的自动安装](docs/operations.md#用户确认的自动安装)。已发布版本变更见 [GitHub Releases](https://github.com/OneOFF-ive/saplink/releases)。

## 🛡️ 变更有明确的步骤

连接默认关闭写入。启用后，SapLink 通过 SAP 权限、对象锁和源码版本检查约束修改，并将保存、语法检查和激活分开处理。SAP 密码保存在 Windows 凭据管理器，MCP 访问令牌独立管理。

SapLink 是开发与查询工具，不是完整 IDE。目前不提供调试、任意 ABAP 执行、对象删除或传输请求释放。写操作可能部分完成，不能视为自动回滚的事务；客户端可根据返回状态读回核实。增强对象的活动版本也不等于运行时已启用。

## 📚 文档

| 你想了解 | 阅读入口 |
| --- | --- |
| 安装、升级或卸载 | [Windows 安装指南](docs/windows-installer.md) |
| 配置连接、接入客户端与排查故障 | [部署与运维手册](docs/operations.md) |
| 理解字段、引用影响与类结构 | [仓库语义查询](docs/repository-query.md) |
| 让 agent 快速学习 SAP 操作 | [MCP 客户端 SAP 操作手册](docs/mcp-client-guide.md) |
| 让终端型 AI 客户端管理本地服务 | [AI 终端管理](docs/ai-management.md) |
| 运行源码、测试与制作安装包 | [开发与构建指南](docs/development.md) |
| 发布版本、配置 GitHub Actions 与下载同步 | [发布与 Actions 手册](docs/releases-and-actions.md) |
| 理解架构与模块职责 | [架构文档](docs/architecture.md) |
| 了解认证、数据和安全边界 | [安全说明](docs/security.md) |
| 下载安装包与查看版本变更 | [GitHub Releases](https://github.com/OneOFF-ive/saplink/releases) |
| 查阅完整接口与技术细节 | [技术参考](docs/technical-reference.md) |

所有文档见 [文档导航](docs/README.md)。

> 产品名称统一为 **SapLink**，CLI 命令为 `saplink`。配置目录、环境变量和安装标识见 [命名与本地数据说明](docs/local-data.md)。
