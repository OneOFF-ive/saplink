# SapLink 命名与本地数据

产品名称为 **SapLink**；CLI、npm 包名和 MCP 服务标识为 `saplink`。管理页面、托盘、安装器、快捷方式和 Windows 应用列表统一显示 SapLink。

| 项目 | 默认位置或标识 |
| --- | --- |
| 程序安装目录 | `%LOCALAPPDATA%\Programs\SapLink` |
| 连接配置和令牌哈希 | `%APPDATA%\saplink\config.json` |
| 助手长期记忆 | 配置目录中的 `agent/memory/library.sqlite`，保存全局偏好及按连接隔离的偏好和排查经验，属于持久数据。使用方式见[长期记忆](agent-runtime.md#长期记忆) |
| 数据查询分页游标密钥 | 配置目录中的 `table-cursor.key`，首次使用分页时生成，由本机 CLI、助手和 MCP 共用 |
| 持久写请求标记 | `%APPDATA%\saplink\cli-write-requests\`，CLI 和所有受控操作使用，随 `SAPLINK_CONFIG_DIR` 更改，不作为缓存清理 |
| 受控审批和结果标记 | `%APPDATA%\saplink\write-approvals\`，含连接及请求指纹、审批终态和结果；操作结果可能含 SAP 元数据、检查结果和诊断，源码审批不保存完整源码；随 `SAPLINK_CONFIG_DIR` 更改，不作为缓存清理 |
| 托管宿主身份及控制认证 | `%APPDATA%\saplink\managed-service.json`，含私密控制令牌，不展示或分享 |
| 运行与操作租约 | 配置目录中的 `runtime.lock`、`config.lock`、`service-command.lock` 及其 `.guard`；不手动清理活动锁 |
| 更新检查缓存 | `%APPDATA%\saplink\update-check.json`，随 `SAPLINK_CONFIG_DIR` 更改 |
| 历史新版本通知 | `%APPDATA%\saplink\update-notice.json`，旧版本可能遗留；新版不再写入，不作为当前更新结论 |
| 自动更新下载目录 | `%APPDATA%\saplink\updates\job-随机字符\`，随 `SAPLINK_CONFIG_DIR` 更改；下载中 installer.part，校验通过后 installer.exe |
| 自动更新最终结果 | `%APPDATA%\saplink\update-install-result.json`，随 `SAPLINK_CONFIG_DIR` 更改 |
| 操作日志 | `%LOCALAPPDATA%\saplink\logs` |
| 配置目录环境变量 | `SAPLINK_CONFIG_DIR` |
| 日志目录环境变量 | `SAPLINK_LOG_DIR` |
| Windows 凭据服务名 | `saplink`，按连接 ID 保存密码 |
| 产品注册表键 | `HKCU\Software\SapLink` |
| 卸载注册表键 | `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\SapLink` |
| 安装清单 ID | `org.saplink.desktop` |
| 源码测试与构建缓存 | 项目目录中的 `.saplink/` |

使用 `saplink status --json` 或 `saplink doctor --json` 核实当前使用的配置目录。密码保存在 Windows 凭据管理器，不写入配置文件。

更新缓存只保存 COS/GitHub 发布元数据和检查时间，不含 SAP 凭据、连接或查询结果。有效期为 24 小时；损坏或过期后重新查询，无法写入缓存时仍返回本次检查结果。`saplink update check --force` 可跳过缓存；`saplink cache clear` 只清理 SAP 会话，不清理此文件。

同一 Windows 用户在原位置升级时继续使用正式版配置目录和 Windows 凭据命名空间。卸载保留用户配置、令牌、日志、凭据和未登记文件。

安装步骤见 [Windows 安装指南](windows-installer.md)，日常操作见 [运维手册](operations.md)。

## 正式安装版与源码开发预览

| 项目 | 正式安装版默认值 | 源码开发预览默认值 |
| --- | --- | --- |
| 配置目录 | `%APPDATA%\saplink` | `%APPDATA%\saplink-3.0-dev` |
| 日志目录 | `%LOCALAPPDATA%\saplink\logs` | `%APPDATA%\saplink-3.0-dev\logs` |
| 管理端口 | 8766 | 18766 |
| MCP 端口（启用时） | 8765 | 18765 |
| Windows 凭据命名空间 | `saplink` | `saplink-3.0-dev` |

两种环境各自保存连接、令牌和助手数据。助手的模型配置和会话保存在各自配置目录的 `agent/` 下，DeepSeek API Key 保存在 Windows 凭据管理器中。正式安装或升级不会自动导入开发预览数据。使用自定义路径或端口时，以对应环境的实际状态为准。

## 项目目录与清理边界

`src/`、`tests/`、`scripts/`、`packaging/`、`skills/` 和 `.github/scripts/` 是维护的源码及回归脚本，不作为临时文件清理。Actions 暂停定义 `.github/workflows/sync-cos-downloads.yml.disabled` 也应保留，恢复时只需改回扩展名。

项目 `.saplink/tests/` 用于隔离测试及本地联调的临时文件。确认相关测试已结束后，可清理已识别的临时参数、预览脚本和空测试目录；不依据目录名称批量终止进程或删除锁。`dist/` 和 `node_modules/` 分别是当前构建结果与开发依赖，日常整理无需删除。`outputs/` 中的安装包、技能 ZIP 和 `.sha256` 是可交付产物，应按需要保留对应版本及校验文件。

项目测试目录不同于用户配置目录。清理项目文件不授权删除 Windows 凭据、真实连接、审计日志、更新任务、`cli-write-requests` 或 `write-approvals`；尤其不能通过删除请求或审批标记来重试 SAP 写入。审批标记保留，即使审批已过期；相关任务附件可能包含源码，应按敏感数据保护。
