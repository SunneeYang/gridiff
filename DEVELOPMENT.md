# Gridiff 开发与发布

本文件供源码维护者使用，不随 VSIX 分发。面向用户的说明放在 README.md。

## 开发环境

使用 Node.js 22+、npm 和 VS Code 1.85+（Open VSX CLI 1.3.0 要求 Node.js 22+）。插件使用原生 JavaScript 和 VS Code API。XLSX 使用 ExcelJS、SSF、yauzl 和 saxes；VSCE 将生产依赖及其许可证一并装入 VSIX，无需打包 JavaScript。

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:ui
npm run package
```

在配置了 Codex 临时目录 harness 的环境中，依赖安装、测试和打包通过 `agent-tmp-run` 执行。VSIX 和界面截图写入被 Git 忽略的 `dist/`。

## 独立程序

`cli/` 使用 Go 完成双侧读取、XLSX 解析、表头转换、类型与主键对齐、差异计算、搜索和分页。`native_xlsx.go` 一边验证 ZIP/XML 一边生成选定工作表；公式只读取缓存结果，源文件不修改，不重新压缩 ZIP 或 Base64 编码。常见数值格式直接格式化，其他格式使用 Excelize 格式化器；每侧工作簿最多缓存 1024 个重复的特殊格式/数值结果。General 显示精度与 SSF 保持一致。两侧解析并行，完成并取得默认比较模型后才向 CLI 返回，避免 Fork 删除临时输入。

默认复用同一构建的后台服务；`--wait` 使用独立前台服务。HTTP 只监听随机回环端口，校验 Host/Origin 和随机会话路径。网页接口不接受文件路径，也不提供写表格接口；CLI 通过独立控制令牌提交新路径，令牌不传给页面。用户缓存目录的私有发现记录按构建摘要区分实例，文件锁串行化启动与提交；记录只含回环地址和令牌，服务退出清理，锁文件保留。

`GET snapshot` 只传元数据和少量阶段日志，不传 CSV/XLSX 内容。`POST compare` 接收 generation、视图和比较设置，返回分页展示模型；Go 先计算全表搜索与变动列并集，再投影当前页的可见字段。记录名称与字段变化提示单独保留，避免隐藏列后丢失标识。每页最多 100 行并受 3000 格预算约束。`native.go` 缓存各表最近配置及两个方向的比较结果，所有缓存仍计入跨表单元格预算；请求串行使用该代内存模型，新文件创建新模型，旧响应不能覆盖新 generation。

`media/browser.js` 管理本地接口、设置对话框、SSE、心跳与结束，不再启动 Worker。视图请求按最新输入串行合并，HTTP 409 触发读取新 generation；比较设置和视图可存入标签的 sessionStorage，源数据不持久化。源码、XLSX ZIP、完整工作簿及完整 diff 不进入浏览器。`src/page.js`、`media/main.js` 和样式继续与插件共享。

VS Code 插件维持 `src/comparison.js`、`src/xlsx-core.js`、ExcelJS 和 SSF 的独立 JS 比较；不调用 Go 或本地 HTTP 服务。插件在页面使用 `media/view.js` 选择视图，独立程序由 Go 选择。`test/native-parity.cjs` 及 Go 差分测试用同样样例比较两条链路的结果，覆盖类型、公式缓存、格式、主键、顺序、搜索和分页。

`media/themes.js` / `themes.css` 只在浏览器入口启用。系统模式监听 `prefers-color-scheme`；手动明暗覆盖系统变化。通过本地 preferences 接口将 `{mode,palette}` 保存为单一配置文件，macOS 位于 `~/Library/Application Support/gridiff/preferences.json`，Linux 使用 XDG 用户配置目录，Windows 使用用户 AppData。默认启动不写配置；手动修改采用临时文件加替换保存，失败会在页面提示。配色是各流行主题色板的表格界面适配，并保持差异语义与文字对比度。

构建使用 Node.js 准备静态网页资源，再用 Go 1.26+、`CGO_ENABLED=0` 和 `-trimpath -ldflags '-s -w'` 生成无外部运行时依赖的程序。网页资源先 gzip 再内嵌，支持 gzip 的浏览器直接接收压缩资源。生成的 `cli/assets/*.gz` 已被 Git 忽略，保留供 Go 开发和测试使用。构建不修改版本、不提交、不上传。

```sh
npm run build:cli
npm run test:go
npm run test:native
npm run test:browser
npm run test:reuse
npm run test:xlsx-snapshot
npm run test:themes
npm run test:binary
npm run build:cli -- --all
```

输出位于 `dist/cli/gridiff-<平台>-<架构>/` 和同名 ZIP 包；`--target` 可单独选 `darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`、`windows-x64`。每个下载包独立携带单个程序、许可和哈希记录，不要求用户下载全部 CPU 版本。交叉编译不代表该平台已经实机验收；macOS 本地构建使用 ad hoc 签名，正式下载分发的 Developer ID 签名和公证另行处理。

`cli/main_test.go`、`cli/xlsx_test.go` 覆盖 HTTP、快照、主题保存、生命周期和读取边界。Go 测试通过 `agent-tmp-run` 在所属 `cli/` module 运行，涉及监听本机端口时需要相应执行权限。`test/native-parity.cjs` 验证原生 Go 与插件 Node 结果一致；`test/browser-ui.cjs` 用实际 Go 程序验证交互；`test/themes.cjs` 验证明暗、偏好恢复与可读性。`test/standalone-binary.cjs` 将程序复制到仓库外，在不含 Node/Bun 的 PATH 中运行，并删除输入文件后验证浏览器仍可完成 CSV/XLSX 对比。

构建随程序内嵌 Go 标准库、实际链接的 Go 模块及 SSF General 算法的许可证，并在下载包提供 `LICENSES.txt`。`gridiff --licenses` 可查看声明。VSIX 排除 Go 目录、浏览器桥接和主题资源，继续携带插件自身的 JS 依赖及许可。

### 随 design 仓库分发

运行 `npm run build:cli -- --all` 后，用 `npm run sync:project -- --project /path/to/design` 预览，再加 `--apply` 写入。脚本校验五个平台的版本、构建来源、大小、SHA-256 与许可证，并要求 Go 源码及内嵌资源的构建输入摘要一致，避免混入旧包。在 `design/gridiff/` 内生成统一入口、平台程序、使用说明和清单；目录内的 `.gitattributes` 将程序交给 Git LFS 管理。它保留不受管理的文件，遇到受管理文件被手工改动会停止，不执行 Git 暂存、提交或推送。

macOS/Linux 的 `gridiff` 和 Windows 的 `gridiff.cmd` 根据系统与 CPU 转发参数。当前支持 macOS/Linux ARM64 和 x64，以及 Windows x64；缺少程序或只取得 LFS 指针时给出明确提示。Fork 只需选择入口，Arguments 保持默认的 `$LOCAL $REMOTE`；CLI 直接接受两个文件路径，同时兼容旧的 `diff` 前缀。成员更新 design 仓库及 LFS 对象即可使用。同步前后应检查 design 的 Git 状态；`manifest.json` 中的 `sourceDirty` 表示是否来自尚未提交的源码。

## 验证

### 性能基线

先构建当前平台程序，再运行基准。使用临时目录 harness 时：

```sh
agent-tmp-run npm run build:cli
agent-tmp-run npm run benchmark
```

对比保留的旧构建可传 `-- --binary /path/to/gridiff --case csv-tall --repeats 5`；程序旁须有原来的 `gridiff.json` 构建记录，脚本会核对 SHA-256。每次只跑一套基准，不要同时构建或执行其他测试。各轮基线和优化结果见 [PERFORMANCE.md](PERFORMANCE.md)。

`scripts/benchmark.cjs` 生成 13 类确定性样本，默认各跑 3 次；可用 `-- --case csv-wide --repeats 1` 定位单个案例。覆盖普通/长/宽 CSV、密集和零变化、引号与中文多行长文本、增删重排、Mova 四行表头和竖表、带类型/日期/公式缓存的 XLSX、含多个工作表但仅比较首表的文件，以及稀疏区域。所有样本均在当前文件与单元格上限内。样本文件写入 harness 临时目录并清理，报告写入被忽略的 `dist/perf/`，包含实际执行程序的 SHA-256、构建来源、环境和每次阶段日志。

加 `-- --reuse` 测量同服务、同页签替换文件；暖替换从 CLI 启动前计时，直到新 generation 的双 requestAnimationFrame，并断言值互换、标题及原生计算标记。冷启动分别记录服务启动、页面准备和导航；浏览器启动仅单独记录一次。`-- --reuse --case csv-tall --cycles 10 --repeats 1` 检查连续替换后的主页面保留堆；每轮强制 GC 会影响下一轮时序，不将该组耗时用于常规性能对比。GC 后主页面 V8 堆和 DOM 计数不包含 Go、RSS 或峰值。

基准先断言预期行列数、增删修改和移动计数，再测量首次打开、重算、翻页、无匹配搜索；多表另测切表，宽表另测显示全部 400 列。每次使用新浏览器上下文，操作系统文件缓存未清空。外层耗时包含 Playwright 驱动等待，界面内部阶段日志更适合定位瓶颈。不要并行运行构建或其他测试来干扰基准。

浏览器加 `#profile=1` 后启用阶段日志，页面最多保留 500 条；默认不启用。Go 快照始终附带少量解析阶段耗时，原生比较请求在 profile 时附带 `native.compute`，页面记录 `native.roundtrip` 和绘制阶段。`render.frame` 使用两次 requestAnimationFrame 估计下一可呈现帧，不是精确像素绘制时间。阶段有嵌套和双侧并行，不能相加作为总耗时。Chrome 的 `performance.memory` 只估计浏览器 JS 堆，不代表 Go、RSS 或峰值内存。日志不输出表格内容、路径、工作表名或搜索词。

- `test/core.test.js` 和 `test/extension.test.js` 验证 CSV、记录对齐、比较结果和 VS Code 交互。
- `test/xlsx.test.js` 动态生成工作簿，验证类型、公式缓存、日期系统、格式、合并格、表头和读取限制；`test/git.test.js` 验证原始二进制 Git 对象读取。
- `test/ui.cjs` 默认使用已安装的 Chrome；可用 `PLAYWRIGHT_CHANNEL` 选择其他 Playwright 浏览器通道。验证两种视图、筛选、分页、长文本、安全文本展示、滚动及浅色/深色布局。
- 在 VS Code 中按 F5 可运行开发宿主。`test/fixtures/before.csv` 和 `after.csv` 是演示数据，不随扩展分发。
- `test/host/index.js` 通过 `--extensionTestsPath` 运行，同时指定 `--extensionDevelopmentPath`。必须使用隔离的 `--user-data-dir` 和 `--extensions-dir`，测试会修改隔离配置。覆盖启动激活、自动打开、保留原差异、关闭不反弹、配置开关、手动入口、文本回退和 Git HEAD。
- macOS 下运行 `agent-tmp-run node test/fork-cli.cjs`，通过隔离的 VS Code 实际执行 `--wait --diff`：XLSX 自动打开 Gridiff，关闭 Gridiff 后进程继续等待，关闭原差异标签后才退出。结果写入 `dist/xlsx-cli-result.json`；这覆盖 Fork 的 CLI 协议，不自动点击 Fork 界面。

宿主测试通过不等于 Fork、其他操作系统或远程工作区的实机验收；分别记录验证范围。

## 比较和显示约定

记录以新 CSV 的顺序为主。删除块放在下一个仍存在的旧记录之前，尾部删除放在旧表最后一个仍存在的记录之后；没有共同记录时，先显示旧表删除，再显示新表新增。顺序变化提示不是最少移动操作数。

变动列按整次比较计算，包含新增行非空字段和已有行变更字段（包括字段增删造成的单元格变化）。删除行不扩大集合；只有删除而没有新增或已有单元格变化时，使用删除行的非空字段。空字符串和不存在的字段不算有值，`0` 和空格算有值。搜索、分页不改变列集合。

页面先过滤记录，再按原顺序分页。每页行数为 `max(1, min(100, floor(3000 / max(1, 显示字段数))))`；固定记录标识列不计入字段数。这是固定限制，不是动态性能检测。

CSV 比较始终保留原字符串。XLSX 的显示字符串与类型、原始值分开保存；主键和值比较使用类型和缓存值，公式表达式不进入比较模型，缺少缓存时视为空值。独立程序使用两个 goroutine 并行解析，按左到右归并结果及日志；失败释放两侧解析结果。Go 保存完整模型，浏览器只接收当前展示范围。VS Code 单线程宿主继续依次读取。数值增减提示跳过超出安全精度的值；百分比以旧值绝对值为分母，旧值为零时省略。文件内容不写入 Webview 持久状态。

`mova-vertical` 与 CSV/XLSX 共用 `readTableRows`：保留源行，以第三列 `name` 对齐，固定前五列为导出标记、类型、名称、说明、值，额外列保留。自动识别检查前五条非空记录：首条为已知 Mova 类型，或至少两条符合标记/类型/名称布局；单条自定义类型需手选格式。类型别名只用于识别，原值不改写。这里遵循源表审阅语义，不复用 Mova 导出时的转置、类型转换或停用行过滤；空名称记录沿用空 ID 的内容匹配规则，类型与标记变化是单元格变化。`test/core.test.js`、`test/xlsx.test.js`、扩展及 UI 测试覆盖这些行为。

XLSX 先流式检查 ZIP 解压大小和 XML 坐标，再加载工作簿；不执行公式或外部引用。XML 预检查按 BOM 识别 UTF-16 LE/BE，兼容 Excel 的 `customXml` 附加部件；仍拒绝 DTD、非法编码和损坏的 XML。只向 Webview 发送当前表的完整结果及其他已加载表的摘要。all/named 按表名配对，仅 first 按位置配对；格式和主键配置只存在当前面板中。HEAD 使用内置 Git API 获取对象和 Git 可执行文件路径，再通过 `cat-file blob` 读取原字节，绕过 `show`/`buffer` 的 `--textconv`。CSV 和 XLSX 的标准差异均通过 `TabInputTextDiff` 自动接管；XLSX 即使原生编辑器显示二进制警告，也可以从标签取得两侧 URI，固定原标签以保留 `--wait`。

运行时依赖检查使用 `npm audit --omit=dev`。2026-10-27 扫描报告 ExcelJS → uuid 的中危传递告警（GHSA-w5hq-g745-h8pq，v3/v5/v6 的外部缓冲区边界）；ExcelJS 仅调用无参数 `v4()`，该调用不在公告触发范围内。暂不跨主版本覆盖传递依赖；升级 ExcelJS 后重新扫描。

## 发布

1. 保持扩展 ID `sunneeyang.gridiff` 不变，递增 `package.json` 和 `package-lock.json` 中的版本号。
2. 更新用户说明；按改动范围运行验证。仅改文档时核对 Markdown、链接和最终安装包，不必重复运行全部界面测试。
3. 运行 `npm run package`，检查包内的发布者、版本、MIT 许可证和 README。排除测试数据、截图、开发依赖及本文件。
4. 将同一个 VSIX 分别上传到 Visual Studio Marketplace 和 Open VSX。Marketplace 发布者和 Open VSX 命名空间均使用 `sunneeyang`，与包内 `publisher` 一致。Open VSX 需完成 Publisher Agreement 签署及命名空间所有权验证。
5. 分别等待两个市场验证，确认各自公开页面显示新版本和新说明，并可下载安装包。Open VSX 的 `under review` 或 `inactive` 状态不代表已公开发布。上传成功、市场可安装和客户端实际更新是不同状态。

README 是两个市场详情的来源，修改本地文件不会直接更新已上架页面，需要重新打包并发布到两个市场。没有公开源码仓库时，不在 README 中使用依赖仓库地址的相对图片或文档链接。

`package.json` 中的 `private: true` 用于防止误发到 npm，不影响 Visual Studio Marketplace 或 Open VSX 发布。许可证检查已开启，不使用 `--skip-license`。

开发依赖的安全检查使用 `npm audit`。此前打包工具的 Azure 登录依赖链报告过涉及 uuid 的中危告警；复核时以当前扫描为准，不把旧告警数量写成固定结论。开发依赖不进入 VSIX，不使用跨主版本覆盖强行消除告警。

## 命令行发布

运行 `npm ci --ignore-scripts` 安装锁定的开发工具后，可以用本地 `vsce` 和 `ovsx` 发布。网页登录状态不能替代 CLI 凭据。

- Marketplace：提供 `VSCE_PAT` 环境变量；PAT 需要 Marketplace 的 Manage 权限，账号需有 `sunneeyang` 发布权限。
- Open VSX：提供 `OVSX_PAT` 环境变量；账号仍需签署协议并拥有 `sunneeyang` 命名空间。CLI 不绕过审核。
- 也可显式使用 `--azure-credential` 让 Marketplace 使用已配置的 Microsoft Entra 凭据，此时不需要 `VSCE_PAT`。Microsoft 正在淘汰全局 PAT，时间安排以官方公告为准；长期自动化可参考[官方说明](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)。脚本不会替你创建凭据、配置身份或授予权限。

Marketplace PAT 需要已有 Azure DevOps 组织的访问权限；新建组织目前要求关联有效 Azure 订阅，不能仅凭 Marketplace 网页登录完成 CLI 配置。

凭据通过当前终端或 CI 的环境变量注入，不写入源码、校验记录或命令参数。执行两个市场发布时，脚本会先检查双方所需的环境变量，避免发布一半才发现缺少另一边的令牌。

macOS 可将令牌保存在登录钥匙串。创建时应限制为所需命名空间且仅允许发布。下面以服务名 `gridiff.ovsx-pat` 为例，将 `YOUR_OPENVSX_ACCOUNT` 替换为保存条目时使用的账户名。需要发布时，关闭 shell 命令追踪（不要开启 `set -x`），从钥匙串注入当前命令：

```sh
OVSX_PAT="$(security find-generic-password -a YOUR_OPENVSX_ACCOUNT -s gridiff.ovsx-pat -w)" \
  npm run release -- --publish openvsx --package dist/release-xxxx/gridiff-0.1.14.vsix
```

首次读取可能要求在本机确认钥匙串访问。令牌到期时间以 Open VSX 页面实际显示为准，可在 Access Tokens 中撤销。`vsce login` 在钥匙串依赖不可用时可能回退到明文 `~/.vsce`，不要将该回退当作安全存储。令牌、环境文件和私钥不得提交到仓库。

先按本次改动验证，再递增版本。脚本不会自动修改版本、提交、创建标签或推送 Git：

```sh
npm version patch --no-git-tag-version
npm run release
```

`npm run release` 默认只运行语法检查、单元测试和打包，**不会上传**。每次在 `dist/release-<随机后缀>/` 下保留一个 VSIX 和同名 `.vsix.json` 校验记录，输出路径及 SHA-256，不覆盖以前的包。打包内容取当前工作目录，包括未提交的用户说明。

配置好凭据后，用输出的实际路径替换下面的示例。两个市场上传同一个已生成的包；`--package` 不重新打包或重新运行源代码测试，而是核对扩展标识、版本记录和安装包 SHA-256：

```sh
npm run release -- --publish all --package dist/release-xxxx/gridiff-0.1.14.vsix
```

也可以省略 `--package`，在一次命令中校验、打包并上传。只发布一个市场时，将 `all` 改为 `marketplace` 或 `openvsx`。使用 Entra 时追加 `--azure-credential`（用于 `marketplace` 或 `all`）。

任何一步失败都会停止。若 Marketplace 已成功、Open VSX 失败，先查明远端是否已接收版本，再仅补发失败的一边：

```sh
npm run release -- --publish openvsx --package dist/release-xxxx/gridiff-0.1.14.vsix
```

保留配套的 `.vsix.json` 文件。此入口只接收本脚本准备的包；不能把任意 VSIX 改名后上传。脚本不忽略重复版本错误，也不会删除或回滚已上传的版本。

上传命令成功不等于上架完成。Open VSX 可能返回 warning 但退出码为 0；仍需检查两个市场的公开版本和下载状态。说明见 [Open VSX CLI](https://github.com/eclipse-openvsx/openvsx/tree/master/cli) 和[命名空间规则](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions)。

### XLSX 可配置读取范围

`sheetSelection` 是读取参数 `{mode: 'all' | 'first' | 'named', names?: string[]}`，与表头、主键和分页选项分离。插件默认 all，通过 `gridiff.xlsxSheets` / `gridiff.xlsxSheetNames` 配置，每次重新读取按原比较右侧 URI 的配置重新取值。插件继续使用自身 JS 读取和 diff，无 Go 可执行程序或本地 HTTP 依赖。

独立程序默认 first；`--sheets first|all` 或可重复 `--sheet 名称` 贯穿前台 --wait、后台 launchRequest 和私有 submit 请求，并保存在每代 snapshot。范围不参与服务发现键，同一服务可连续接收不同范围。页面从快照取得范围，不能被 sessionStorage 中保存的逐表设置覆盖；扩大范围需要重新提交文件。

独立版由 `cli/native_xlsx.go`、插件由 `src/xlsx-sheets.js` 在 first/named 模式解析 workbook.xml 的工作表顺序、名称及 workbook.xml.rels 对应关系，确定保留路径。包含隐藏表，不根据文件编号或 activeTab 选择。未选工作表及其关系部件在解压前丢弃，不校验被剔除内容或 CRC；ZIP 目录路径、重复成员、加密、总声明体积和数量限制仍覆盖整包。共享字符串、样式和日期设置保留。all 模式沿用全量 ZIP/XML 校验；不能跳过未经解析的元数据。所选工作表关系损坏时直接报错。

插件使用 JSZip 复制所选 DEFLATE 部件后交给 ExcelJS，`src/xlsx-core.js` 规范化全部保留表。独立程序直接流式解析所选 XML，不生成中间工作簿。两侧按名称模式读取完成后检查指定名称的并集：单侧缺失是增删，双侧缺失是错误。只有显式 first 模式允许不同表名按位置配对。

`test/sheets.test.js`、扩展测试及 Go archive/reuse 测试覆盖选择、缺失和校验边界；`test/sheet-selection.cjs` 使用实际可执行程序验证 CLI、同页范围切换、逐表设置、交换/恢复和未选表过滤。真实 Go 测试覆盖 first/all/named 的解析前选择；未选损坏表不会解压。

### 两种运行模式的边界

插件维持独立 JS 解析、比较与 Webview 展示，可独立打包发布。独立程序由 Go 完成解析、比较、搜索和分页，浏览器只展示当前结果。两条链路可共用显示协议和测试样例，不能让插件依赖本地原生服务。
