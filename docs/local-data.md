# SapLink 命名与本地数据

产品名称为 **SapLink**；CLI、npm 包名和 MCP 服务标识为 `saplink`。管理页面、托盘、安装器、快捷方式和 Windows 应用列表统一显示 SapLink。

| 项目 | 默认位置或标识 |
| --- | --- |
| 程序安装目录 | `%LOCALAPPDATA%\Programs\SapLink` |
| 连接配置和令牌哈希 | `%APPDATA%\saplink\config.json` |
| CLI 持久写请求标记 | `%APPDATA%\saplink\cli-write-requests\`，随 `SAPLINK_CONFIG_DIR` 更改，不作为缓存清理 |
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

1.0.0 是首个正式版本，只使用上述名称和标识，不提供开发阶段旧名称、旧目录或旧凭据标识的自动迁移。卸载保留用户配置、令牌、日志、凭据和未登记文件。

安装步骤见 [Windows 安装指南](windows-installer.md)，日常操作见 [运维手册](operations.md)。

## 项目目录与清理边界

`src/`、`tests/`、`scripts/`、`packaging/`、`skills/` 和 `.github/scripts/` 是维护的源码及回归脚本，不作为临时文件清理。Actions 暂停定义 `.github/workflows/sync-cos-downloads.yml.disabled` 也应保留，恢复时只需改回扩展名。

项目 `.saplink/tests/` 用于隔离测试及本地联调的临时文件。确认相关测试已结束后，可清理已识别的临时参数、预览脚本和空测试目录；不依据目录名称批量终止进程或删除锁。`dist/` 和 `node_modules/` 分别是当前构建结果与开发依赖，日常整理无需删除。`outputs/` 中的安装包、技能 ZIP 和 `.sha256` 是可交付产物，应按需要保留对应版本及校验文件。

项目测试目录不同于用户配置目录。清理项目文件不授权删除 Windows 凭据、真实连接、审计日志、更新任务或 `cli-write-requests`；尤其不能通过删除写请求标记来重试 SAP 写入。
