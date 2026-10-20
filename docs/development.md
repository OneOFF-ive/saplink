# SapLink 开发与构建指南

本指南面向修改源码、运行测试和制作安装包的开发者。普通用户请阅读 [Windows 安装指南](windows-installer.md)；已安装应用的日常操作统一使用 [运维手册](operations.md) 中的 `saplink` 命令。

GitHub Release 附件要求、COS 同步 Action 的触发条件、secrets 和恢复步骤集中见 [发布与 GitHub Actions](releases-and-actions.md)。当前 Actions 只同步已构建的正式版附件，不承担源码构建或 push/PR 自动测试。

## 从源码运行

需要 Windows、Node.js 22+ 和 npm。在项目根目录的 PowerShell 执行：

```powershell
npm ci --ignore-scripts
npm run build
node dist/cli.js --help
```

项目的 `vendor/adt-path-format` 通过 npm override 替换 ADT 库的通用格式化依赖，仅支持其路径所需的字符串占位符。保留 `vendor/`、锁文件和 `.npmrc` 中的 `install-links=true`；Windows 构建在生产依赖安装前复制该目录，并显式使用 `--install-links`。修改 ADT 库版本时运行 `tests/dependency-security.test.ts`，核对其格式化调用仍符合这一受限接口。

这些是源码开发命令，不是安装包用户的前置步骤。后续源码 CLI 调用统一使用 `node dist/cli.js`，例如：

```powershell
node dist/cli.js ui
node dist/cli.js status --json
node dist/cli.js doctor --json
node dist/cli.js update check --json
```

`node dist/cli.js ui` 在前台运行，保持终端开启，用 Ctrl+C 正常退出；关闭浏览器不会结束进程。`start-ui.cmd` 是源码目录的便捷入口。源码与已安装应用默认共用用户配置目录，不要同时启动；需要隔离测试时使用专用 `SAPLINK_CONFIG_DIR` 和 `SAPLINK_LOG_DIR`。

运维手册中的 `saplink <参数>` 对应项目目录内的 `node dist/cli.js <参数>`。`npm start -- <参数>` 也是项目脚本入口，但不用于用户运维示例；自动化优先直接运行 Node CLI，避免 npm 附加输出影响 JSON 解析。

## 测试与接口维护

版本检查模块为 `src/updates.ts`，当前版本取自 `package.json`，默认优先读取 COS 的 `saplink/latest.json`，不可用时回退 `OneOFF-ive/saplink` 的 GitHub `releases/latest` 接口。正式标签须为语义版本（可带 `v` 前缀）；仅提示版本更高的正式发布，同号正式版高于本地预发布版。不是按字符串或发布时间比较版本；GitHub latest 指定的版本也不一定是所有标签中的最大版本。

版本检查使用独立的 `update-check.json` 缓存，不获取 runtime/config 锁。HTTP 请求不携带 SAP 或 MCP 凭据、不跟随重定向，每个源请求设置 8 秒超时；检查本身不执行安装文件。显式确认安装由独立的 self-update 模块处理，见本文末尾实现说明。检查模块允许注入 fetch 和时间供离线测试，覆盖比较、缓存与强制刷新、错误响应及 CLI 文本/JSON 输出。

CLI postAction 为成功启动的 `ui`、`serve`、`service _run` 接入自动检查器；定时器 unref，不单独维持进程。同一进程避免检查重叠，启动时异步检查，随后每 24 小时执行并复用缓存；SIGINT/SIGTERM 取消请求并清理定时器。`SAPLINK_AUTO_UPDATE_CHECK=0` 禁用。自动失败静默，不影响 SAP；相同新版本只通知一次。受保护的 `/api/state` 暴露最近成功的自动检查结果，Web 每分钟刷新可见页面的更新提示，不触发 GitHub 查询。不注册 MCP tool。

构建后可单独运行 `node --import tsx --test tests/updates.test.ts`。模拟测试不证明真实 GitHub 可达；发布前还需在可联网环境验证 `node dist/cli.js update check --force --json`，并确认新安装包已包含该功能。

```powershell
npm run build
npm test
```

自动化测试主要使用模拟 SAP，不等于真实系统验收。可选浏览器检查及工具实现细节见 [技术参考](technical-reference.md)。

工具 schema 和描述位于 `src/tool-definitions.ts`，注册位于 `src/server.ts`，业务行为位于 `src/operations.ts`。写操作分类集中在 `src/tool-policy.ts`，MCP annotations 与业务层写保护共用该集合；初始化客户端指引位于 `src/client-guidance.ts`。修改接口时同步核对客户端手册示例。

架构与模块职责见 [架构文档](architecture.md)，源码接口与历史实现细节见 [技术参考](technical-reference.md)。

## Windows 安装包构建与验证

程序图标原图保存在 `packaging/windows/assets/app-icon.png`。构建会从原图生成 16、24、32、48、64、128、256 像素的 Windows ICO，并写入启动器、安装程序及卸载程序。托盘直接读取安装目录的 `saplink.ico`；快捷方式和应用列表明确引用带内容哈希的 `saplink-<hash>.ico`，安装后通知 Windows 刷新图标。管理页面引用 `web/app-icon-<hash>.png` 作为侧栏标识及浏览器图标；更换原图时文件名随内容变化，避免继续命中旧缓存。`web/app-icon.png` 保留为兼容资源，构建时同步生成并自动更新页面引用。

在 Windows 项目目录先执行 `npm ci --ignore-scripts`，然后执行 `npm run package:windows`。构建需要 Node.js/npm、Windows 自带的 .NET Framework C# 编译器和 PowerShell 5.1。首次构建需要联网；用户安装生成的包时无需联网。

GUI 启动器使用 .NET Framework 4.7 目标声明、`GuiLauncher.manifest` 的 Windows 10 兼容声明，以及随包复制到 `bin/saplink-gui.exe.config` 的 WinForms `PerMonitorV2` 配置。在创建托盘或菜单窗口前初始化 DPI 感知，旧 Windows API 不支持逐显示器 V2 时回退到系统 DPI，避免高缩放下的位图拉伸。不要只分发 EXE 而遗漏对应配置；DPI 设置属于启动器进程，更新网页无法修复已运行的旧托盘程序。修改后需重新构建安装包并重启托盘程序，验证高缩放菜单及明暗、高对比度主题。

构建会运行测试，下载 `packaging/windows/download-lock.json` 固定 SHA256 的 Node.js、NSIS 和微软 VC 运行库，并验证微软运行库及所选 DLL 的有效微软签名。VC 包只作为 CAB 数据解包，不执行其安装程序，不安装全局组件。发布时更新版本与下载锁，不关闭哈希校验。微软动态下载 URL 如果变更，构建会拒绝新哈希，需显式审核并更新锁文件。

```powershell
npm run package:windows
# 只构建一个处理器版本（已完成测试时可用 -SkipTests）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging/windows/build.ps1 -Architecture x64
# 在本机可运行对应架构时验证安装、命令、升级与卸载
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging/windows/smoke-test.ps1 -Architecture x64
# 单独验证安装前检查：失效锁、PID 复用、活动锁、门锁与损坏锁
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging/windows/preflight-test.ps1
# 验证隐藏依赖、点文件、空目录清理，以及未知文件保留和路径边界
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging/windows/payload-test.ps1
```

### 更新版本并打包

使用发布脚本传入目标版本即可同步更新 `package.json`、`package-lock.json`，执行项目测试并生成安装包：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File packaging/windows/release.ps1 -Version 1.0.1
# x64 构建机只打包 x64
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File packaging/windows/release.ps1 -Version 1.0.1 -Architecture x64
# 已完成测试时，重新编译并打包，跳过测试
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File packaging/windows/release.ps1 -Version 1.0.1 -Architecture x64 -SkipTests
```

脚本按自身路径定位项目，从其他目录调用时请传入脚本的完整路径。项目位于普通盘符路径时，也可使用简写 `npm run release:windows -- 1.0.1`；项目位于 `\\psf\...` 等 UNC 共享目录时，使用上面的 PowerShell 命令，避免 `npm.cmd` 因 CMD 不支持 UNC 工作目录而找不到项目。

版本必须为 `主版本.次版本.修订号`，例如 `1.0.1`，每段为 0–65535 的整数；不接受 `v` 前缀、前导零或预发布后缀。默认构建 x64、ARM64，执行平台要求见下文。产物放入 `outputs/installers/<version>/`，并核对 SHA256；同版本可重新打包，不改动其他版本目录。

脚本不创建 Git 提交或标签，不运行 npm 版本生命周期钩子，也不上传发布。构建失败时保留已更新的版本号，修复错误后可使用同一命令重试；目录内存在部分文件不代表发布成功，应以脚本成功结束为准。完整安装、升级和卸载验证仍使用上面的 `smoke-test.ps1` 单独执行，发布说明需按实际变更和验证结果编写。

发布脚本自身的隔离回归检查如下。检查使用临时项目、真实 npm 版本更新和模拟构建，不更改本项目版本，也不生成真实安装包：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File packaging/windows/release-test.ps1
```

发布产物按 `package.json` 的版本号输出到 `outputs/installers/<version>/`，例如 `outputs/installers/1.0.0/`。每种架构只生成一个标准名称安装包及对应 `.sha256`，对应版本的发布说明也放在该目录；不同版本分别保留，同版本重打包只更新自己的目录，不影响其他版本。不再生成图标后缀副本。公开分发的文件保持版本唯一；更换图标或程序后更新版本号，避免覆盖同版本文件引起缓存混淆。安装包只包含明确选定的应用文件和生产依赖；源码、测试、本地连接配置、凭据、缓存均不打包。第三方许可随包提供：Node 位于 `runtime/LICENSE`，VC 运行库与 NSIS 位于 `licenses`，依赖许可位于各 `app/node_modules` 包中。

测试安装包单独输出到 `.saplink/installer-build/tests`，不进入发布目录。隔离安装测试使用专用临时目录和 `HKCU\Software\SapLinkInstallerTest`，不修改真实用户 PATH 或桌面；测试快捷方式放在测试安装目录内。测试会保留临时文件用于排错，不应将 `-test-setup.exe` 作为发行包分发。不同架构的测试依次执行，因为它们使用同一个测试注册表位置。

构建包含目标 Node 与原生凭据模块的执行检查。x64 Windows 不能执行 ARM64 检查，因此在 x64 构建机选择 `-Architecture x64`，ARM64 产物在 ARM64 构建机生成。ARM64 Windows 11 可以在支持 x64 模拟的环境生成并检查两个版本。

## COS 双更新源发布

国内入口为 `https://saplink-1302377695.cos.ap-shanghai.myqcloud.com/saplink/latest.json`。正常情况下只访问 COS；COS 超时、HTTP 错误（包括 404）、无效元数据时才访问 GitHub。不是同时查询后选择最大版本，因此必须在发版时同步清单。两处均失败时报告无法检查；COS 不可用且 GitHub 返回 404 时为未知最新版，不认定已是最新。

`SAPLINK_UPDATE_URL` 可设为自有 HTTPS 清单 URL（不含凭据、查询或片段），也可设为 `github` 仅使用 GitHub。自动检查进程需重启才读取新环境；切换源会使原缓存失效。每个源请求超时 8 秒，串行回退可能合计接近 16 秒；后台失败保持静默。

`release:windows` 成功后生成 `outputs/installers/<version>/latest.json`，只包含本次构建的架构。也可以为已有安装包生成，不重打包或变更项目版本：

```powershell
node scripts/create-update-manifest.mjs --version 0.1.0 --architectures x64
```

脚本要求标准命名的真实安装包和对应 `.sha256`，重新计算 SHA-256 并核对后才原子写入清单；缺失或校验不符则失败。不用 ETag 当 SHA-256，不为未上传的架构猜下载链接。企业源可传 `--base-url https://updates.example.com/saplink/`；支持 `--directory` 指定本地安装包目录、`--out` 指定清单输出文件。

发布顺序：

1. 将该版本安装包与 `.sha256` 上传 COS 的 `saplink/v<version>/`，保留版本唯一文件名。
2. 公开下载并验证 SHA-256，确认清单中列出的每种架构都可访问。
3. 最后将本地 `latest.json` 上传覆盖 COS 的 `saplink/latest.json`，不要放在版本子目录。元数据建议设置 `Content-Type: application/json`、`Cache-Control: no-cache`；安装包使用长期缓存，发布后不覆盖同版本二进制。
4. 用 `saplink update check --force --json` 确认 `source=cos`、版本、架构 URL 与 SHA-256。管理页面会按架构展示国内直达下载链接，CLI 在文本/JSON 中也提供。

清单结构如下（示例哈希需由脚本替换，不能直接发布）：

```json
{
  "schema_version": 1,
  "version": "0.1.0",
  "published_at": "2026-10-17T00:00:00Z",
  "downloads": [{
    "architecture": "x64",
    "url": "https://saplink-1302377695.cos.ap-shanghai.myqcloud.com/saplink/v0.1.0/SapLink-0.1.0-win-x64-setup.exe",
    "sha256": "<64位小写SHA-256，由脚本计算>"
  }]
}
```

清单仅支持正式三段版本，架构 x64/arm64，每种最多一次。下载 URL 必须与清单同源，路径与版本及标准文件名一致，不允许秘密、重定向 URL 或任意第三方下载地址。更新检查只返回校验值，不自动下载、校验或执行安装包。同一存储源提供的哈希不能独立证明发布者身份。

旧安装包不包含新增双源逻辑，上传清单不会为旧进程增加功能；需要重新构建并由用户手动安装包含该功能的版本。当前源代码版本若高于清单版本，会正确显示没有更高版本，不提示降级。

### GitHub Release 自动同步到 COS

工作流为 `.github/workflows/sync-cos-downloads.yml`，与官网同步独立运行。将工作流及脚本推送到 `main` 后生效；GitHub 发布正式 Release 自动触发，跳过预发布。先将两个架构安装包作为附件上传到 Release 草稿，再发布。脚本允许等待附件和 GitHub SHA-256 元数据就绪，超时失败，不发布半套更新。

仓库 Actions secrets 使用 `COS_SECRET_ID`、`COS_SECRET_KEY`。固定目标为桶 `saplink-1302377695`、地域 `ap-shanghai`，对象前缀 `saplink/`。使用专用子账号，保留 `cos:GetObject`、`cos:HeadObject`、`cos:PutObject`，并为断点续传增加 `cos:InitiateMultipartUpload`、`cos:UploadPart`、`cos:CompleteMultipartUpload`、`cos:ListMultipartUploads`、`cos:ListParts`。对象操作限制为该前缀；列举上传任务按腾讯云对应桶资源授权。若之前按单次 PUT 的最小策略授权，需要先补齐这些权限，无需重新生成密钥，也不需要授予整个账号的管理权限、修改桶 ACL 或删除已发布对象的权限。[腾讯云分块上传权限说明](https://cloud.tencent.com/document/product/436/65820)。密钥仅在 COS 上传步骤的环境中读取，不传命令参数，不展示 SDK 错误正文或请求上下文。桶的公开读权限需已配置，工作流不会改变它。

脚本复用官网同步的官方 Release 下载与 GitHub digest 校验，上传前再次计算本地 SHA-256。安装包使用固定版本 SDK 的 1 MiB 分块上传，最多三个并发线程，SDK 重试失败块；重跑时 SDK 校验已有块后续传，不重新上传整个文件。初始化和最终合并均设置禁止覆盖同名对象，合并时额外补齐 SDK 1.9.44 高级接口未透传的禁止覆盖头。未完成的分块任务保留以供重跑；不再使用的任务可由维护者在 COS 控制台核实后清理，脚本不删除已发布对象。

先上传版本目录内的二进制和 `.sha256`，通过匿名 HTTPS 实际下载核验，然后才提交根目录 `saplink/latest.json`。公开安装包以 1 MiB Range 分段回读，每段最多尝试三次；核对 Content-Range、总长度和一致 ETag，全部字节按顺序计算完整 SHA-256，任何不一致都不发布清单。上传、回读和提交均显示阶段与字节进度，工作流总时限为 90 分钟。链路持续不可用时仍可能失败；不能把超时或仅上传成功视为发布完成。清单使用 GitHub 的正式发布时间，设置 JSON Content-Type 和 `Cache-Control: no-cache`；版本文件使用不可变长期缓存。不重新构建 Release 附件，也不执行安装包。

所有 COS 同步运行通过同一 concurrency group 串行化。同步前后检查 GitHub latest 身份以及 COS 当前版本，旧事件或补发旧版本不会覆盖较新指针；同版本不同内容、已有损坏二进制或异常清单会报错，不静默覆盖。失败可在 Actions 重跑，已上传文件会重新核验并复用，旧 latest.json 在发布新指针前保持不变。发布期间不要同时手工覆盖 COS 清单；该并发保护不包含平台外的人工写入。

首次补同步现有正式版：GitHub → Actions → **Sync COS downloads** → **Run workflow**，`release_tag` 留空同步 GitHub 最新正式版。指定旧 tag 时，如果它已不是 GitHub latest，就会跳过。完成后访问 COS 的 `saplink/latest.json` 并检查 workflow 日志。不要为了同步已有安装包另发重复版本或覆盖原二进制。

如果 Release 是由其他工作流用默认 `GITHUB_TOKEN` 创建，GitHub 通常不会再触发 release 工作流；发布流程应在附件上传完成后显式调用此 reusable workflow（`workflow_call` 并传递这两个 secrets），或手动 dispatch。主分支没有工作流/脚本时，仅配置 secrets 不会自动上传。

同一 Action 将发布标签中的 `skills/saplink-manager/` 打包为 `saplink/v<version>/SapLink-<version>-skill.zip`。安装包与技能文件全部校验通过后，先发布独立的 `saplink/skill-latest.json`（schema_version、version、published_at、skill），再提交 `saplink/latest.json`。安装包清单严格只包含 schema_version、version、published_at、downloads，兼容已发布的 1.0.4 等严格校验客户端；禁止向其中追加 skill 字段。技能清单保留 commit、filename、url、size、sha256，官网单独读取，异常不影响安装包下载。修复误加 skill 的线上清单时，在 Sync COS downloads 手动运行中勾选 repair_metadata；该模式校验并备份现有清单，只迁移元数据，不下载、修改或重传安装包。

本地隔离回归：`python .github/scripts/test-sync-cos-release.py -v` 和 `python .github/scripts/test-skill-archive.py -v`。只使用模拟安装包、技能源码和内存 COS，不读取密钥或操作云端。

## 自动更新实现与验证

`src/self-update.ts` 负责安装版识别、强制重查版本、架构匹配、流式下载、256 MiB 上限、SHA-256 和 PE 文件头校验、任务互斥及原生助手握手。Web 的检查/安装/状态接口沿用管理 API 的 token 与同源限制；安装请求只接受待确认的版本，不接受 URL、哈希、目录或命令。下载不携带 SAP/MCP 凭据且拒绝重定向。

`packaging/windows/update-runner.ps1` 随安装包放在根目录。运行时复制到用户配置目录的独立任务目录，由原生启动器创建独立隐藏控制台，避免占用待替换程序或继承终端管道。助手复核注册的安装路径、安装清单、版本资源与哈希，等待原进程正常退出后执行 NSIS `/S /D=<原目录>`，验证安装清单版本再恢复原运行方式。安装根目录、任务目录不能混用，更新器不强杀进程、不修改全局机器安装。

自动安装结果异步写入 `update-install-result.json`，不是 SAP 审计日志。更新助手超时返回未知时不释放更新标记；客户端断开不能证明安装失败或成功。下载哈希来自已配置 HTTPS 发布源，不单独证明发布者身份；只为用户明确选择的版本执行安装。

检查：`node --import tsx --test tests/self-update.test.ts`；浏览器需检查源代码运行下的禁用说明以及安装版的确认、进度、失败和重启提示。完整原生隔离测试：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File packaging/windows/update-test.ps1
```

原生测试使用临时模拟安装目录及 `Software\SapLinkInstallerTest` 注册表，不更改真实安装与用户 PATH，涵盖启动器编译、隐藏助手交接、哈希拒绝、含空格路径的真实 NSIS 静默升级、版本验证和配置保留。它需要已缓存的 NSIS 和安装图标，不能与其他占用同一测试注册表的安装测试同时运行。`-TestMode` 不由生产启动入口传递。
