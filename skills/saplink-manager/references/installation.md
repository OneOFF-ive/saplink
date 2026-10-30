# 下载、安装与卸载

适用于用户本机 Windows 10/11 的 SapLink 安装包。当前任务为通过 CLI 使用 SAP 或配置连接，也必须先处理已确认的安装缺失；不能要求业务人员自行编辑配置。远程或容器终端不是用户本机 Windows 时，说明执行位置限制，提示用户手动安装到本机，不向远端或其他 Windows 用户静默安装。

用户仅要求下载安装包时，只下载、校验并报告保存位置，不启动安装、不修改 PATH，也不要求确认安装目录。以下安装授权和路径确认适用于实际安装任务。

## 先确认安装是否真的缺失

检查 `Get-Command saplink`、当前用户的 `HKCU\Software\SapLink` 的 `InstallDir`，以及 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\SapLink` 的 `InstallLocation`，必要时核对注册表视图、用户和系统 PATH、默认目录。安装目录内的 `install-manifest.json` 应声明 `app_id=org.saplink.desktop`，并有 `bin\saplink.exe`。PATH 未刷新时用已核实的绝对路径执行 `version --json`，不要重复安装。

发现残留注册、版本矛盾、无法访问或安装损坏时先诊断；不把它当作未安装，不删除安装目录、注册表或运行锁。已有正常安装时按原位置维护，不能为换路径自动卸载。

当前完整安装包携带 Node.js、Java 和 JCo，固定使用随包组件，不要求用户配置 `JAVA_HOME`、CLASSPATH 或 JCo 路径。安装后以实际版本和 `doctor` 结果验证；旧版不能仅依据本技能假定已具备随包 RFC 环境。

## 安装授权与目录

1. 确认缺失后询问用户是否需要下载安装，并告知默认目录 `~\AppData\Local\Programs\SapLink`。这是 Windows 用户目录，不能按 Bash/WSL 的 HOME 展开。
2. 得到肯定答复后确认路径；也可在同一个问题中同时确认安装意愿和默认/自定义路径。展示默认路径展开后的实际绝对路径，例如 `C:\Users\用户名\AppData\Local\Programs\SapLink`。默认目录按当前 Windows 用户的 `$env:USERPROFILE` 展开；用户明确选择“默认”即可，不必再问一次。仅回答“安装”而没有选择路径时，补问路径。用户已明确要求安装并指定有效目录时，不重复确认。
3. 将用户选择规范化为本机磁盘绝对路径，允许空格和中文。拒绝盘符根目录、Windows 系统目录、无法安全解析的路径及命令控制字符；不要改用其他目录来绕过访问失败。路径已有无关文件或其他程序时先说明冲突，不自动覆盖。当前安装包为当前用户安装，不申请管理员权限来强行安装到受保护目录。
4. 只有安装意愿和路径都明确后，才下载安装包并启动安装。用户拒绝或选择稍后时停止依赖安装的任务。

## 下载顺序与校验

先检查原生 Windows 架构，而非仅看终端进程架构：优先使用 `[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture` 等原生系统信息，再结合 `$env:PROCESSOR_ARCHITEW6432`、`$env:PROCESSOR_ARCHITECTURE` 交叉检查；模拟终端信息有歧义或无法确定时询问。普通 x64 电脑选 x64，Windows ARM64 选 arm64，不擅自改用模拟架构。包含 RFC 运行环境的 ARM64 完整包需要 Windows 11；其主程序为原生 ARM64，内部独立的 x64 Java/JCo 子进程由产品管理，不要求用户另外选择 x64 安装包或安装 ARM64 Java。

依次尝试以下发布源；前一来源不可访问、没有对应架构或元数据/下载不可用时，再尝试下一来源。每个来源一次正常尝试，网络瞬态错误至多再试一次，不无限重试。

| 优先级 | 发布入口与元数据 | 取得安装包的方法 |
| --- | --- | --- |
| 1 COS | [COS 版本清单](https://saplink-1302377695.cos.ap-shanghai.myqcloud.com/saplink/latest.json) | `schema_version=1`，从 `downloads` 取匹配 `architecture` 的 `url`、`sha256`，并读取 `version` |
| 2 GitHub | [正式发布页](https://github.com/OneOFF-ive/saplink/releases)，API `https://api.github.com/repos/OneOFF-ive/saplink/releases/latest` | 从非 draft、非 prerelease 的正式 Release 选择标准附件，并核对 API `digest` 中的 SHA-256；不安装源码归档 |

安装版本必须为正式三段版本，对应文件名为 `SapLink-<version>-win-<architecture>-setup.exe`。固定首次确认的目标版本和架构，回退来源时不得混用其他版本的哈希或静默降级；如后备源仅有其他正式版本，说明差异并让用户选择。不要将不同来源的清单当成同一种 schema。

COS 以对应 HTTPS 发布清单中的 SHA-256 为基准；能读取 GitHub 同版本的官方 digest 时也应交叉核对。若可信元数据之间相互矛盾，停止并说明，不能任选一个来执行。不猜安装包 URL，不使用不明镜像。官网不再托管安装包，不请求官网版本清单或历史安装包地址。COS 不可用时回退 GitHub，不改用明文 IP 地址或忽略 TLS 证书校验。

将安装包保存到当前用户私有的临时目录；下载不携带 SAP 密码、MCP 令牌或管理会话凭据。只允许已核实的 COS 地址及 GitHub 官方附件重定向；不把 GitHub API 认证头转发到附件 CDN。下载流最大 256 MiB，有超时；校验非空、元数据声明的大小（如有）、Windows 可执行文件头及 `Get-FileHash -Algorithm SHA256`。可读取版本资源核对产品 SapLink 与版本。未签名不等于来源已核实，签名不能替代上述哈希校验。

哈希不符或下载未完成时，不执行该文件；报告当前源失败，按既定优先级取得同一目标版本的有效文件。所有来源均失败或校验无法完成时，停止并明确提醒用户从已知官方入口手动下载、安装，安装完成后再继续配置。

## 执行与确认安装

对当前已核实的 NSIS 官方安装包，使用 `/S` 静默安装，`/D=<确认目录>` 必须放在参数最后，目录不额外加引号。使用 `Start-Process` 的独立参数执行，不能构造经 `cmd /c`、`Invoke-Expression` 或另一个 shell 再解释的字符串。示意中的两个路径变量必须来自前述校验与用户确认：

```powershell
$process = Start-Process -FilePath $installerPath -ArgumentList @('/S', ('/D=' + $installDirectory)) -WindowStyle Hidden -PassThru
if (!$process.WaitForExit(180000)) { throw '安装尚未确认完成，请先核实安装进程状态，不要重复启动。' }
$process.ExitCode
```

等待有上限；超时后核实是否仍在安装，不强杀或重复启动。退出码 0 只是必要条件：重新核对注册表 `InstallLocation`/`InstallDir` 与确认目录、安装清单的产品/版本/架构，使用该目录下 `bin\saplink.exe version --json` 和 `doctor --json` 验证。不同版本不支持某诊断命令时说明能力限制，不据此重复安装。不能仅凭存在同名文件或进程退出就报告安装完成。

当前终端可能尚未刷新 PATH；Agent 继续使用已核实的启动器绝对路径完成 SAP 连接配置和 CLI 能力发现、登录验证，不将“让用户重开终端”作为配置工作的替代。新终端仍应能解析 `saplink`。未请求使用 SAP 的纯安装任务，只验证安装，不额外创建令牌或启动服务。

安装失败、部分完成或无法确认时，停止自动安装，报告退出码/已知状态和实际目标目录，明确提示：“自动安装未成功或尚未确认完成，请手动运行官方安装包，选择此目录完成安装。”有仍在运行的安装进程时先说明需等待其结束，不让用户同时再安装。保留必要诊断，不删除可能已写入的安装目录、配置、凭据或注册表以强行重试。

## 卸载：仅接受明确要求

只有用户明确说“卸载 SapLink”“移除 SapLink 程序”等，才执行卸载。停止服务、断开 MCP、删除连接、清理缓存、升级失败、安装损坏或希望更换目录，都不构成卸载授权。对“清理一下”等模糊表述先澄清，不主动提出或执行卸载重装作为常规修复。

1. 识别当前 Windows 用户的真实安装，核对注册表的 `InstallLocation`、`UninstallString` 与安装清单。明确报告将卸载的版本/目录，以及配置、令牌、日志、SAP 凭据和 AI 客户端条目会保留；已有明确卸载要求且目标唯一时不重复询问。有多个目标、其他用户的安装或身份矛盾时先确认，不能任选目录。
2. 正常停止托管服务；UI/前台进程按[运行管理](local-management.md#配置锁与正常退出)正常退出。无法正常退出时停止自动卸载，提示用户手动关闭后通过 Windows 应用设置卸载，不强杀或删锁。
3. 运行已核实安装目录内的 `Uninstall.exe /S`；注册的 `UninstallString` 仅用于核对，不直接作为 shell 命令执行。不要用删除文件夹代替卸载，不用 `saplink uninstall` 等不存在的命令，也不安装第三方清理工具。
4. 使用有界等待核对卸载结果。NSIS 卸载器可能复制自身后继续执行，`Start-Process -Wait` 返回不能单独证明卸载结束。核实产品注册项与原目录中的程序载荷确已移除；旧终端 PATH 字符串尚未刷新不代表卸载失败，仍须核对用户 PATH 的实际注册值。保留的用户数据或无关文件不应被视为需要递归删除的残留。
5. 只有验证通过才报告卸载成功。失败、部分完成、超时或无法确认时明确提醒：“自动卸载未成功或尚未确认完成，请在 Windows 设置 → 应用 → SapLink 中手动卸载，或使用开始菜单中的卸载入口。”说明已知状态，不重复运行卸载器、不删除目录/注册表或个人数据补救。

卸载不授权删除 MCP 客户端配置、配置目录、日志、令牌备份或 Windows 凭据，也不授权随后重装；这些操作必须由用户另行明确要求。配置和凭据保留意味着卸载后仍可能存在敏感数据，按实际结果告知即可。
