# SapLink 命名与本地数据

产品名称为 **SapLink**；CLI、npm 包名和 MCP 服务标识为 `saplink`。管理页面、托盘、安装器、快捷方式和 Windows 应用列表统一显示 SapLink。

| 项目 | 默认位置或标识 |
| --- | --- |
| 程序安装目录 | `%LOCALAPPDATA%\Programs\SapLink` |
| 连接配置和令牌哈希 | `%APPDATA%\saplink\config.json` |
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

更新缓存只保存 GitHub 发布元数据和检查时间，不含 SAP 凭据、连接或查询结果。有效期为 24 小时；损坏或过期后重新查询，无法写入缓存时仍返回本次检查结果。`saplink update check --force` 可跳过缓存；`saplink cache clear` 只清理 SAP 会话，不清理此文件。

1.0.0 是首个正式版本，只使用上述名称和标识，不提供开发阶段旧名称、旧目录或旧凭据标识的自动迁移。卸载保留用户配置、令牌、日志、凭据和未登记文件。

安装步骤见 [Windows 安装指南](windows-installer.md)，日常操作见 [运维手册](operations.md)。
