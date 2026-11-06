<h1 align="center">Gridiff</h1>

<p align="center">
  <strong>看清每一个单元格的变化。</strong><br>
  对比 Excel / CSV 的 Git 历史、本地修改或两份文件。<br>
  在浏览器、VS Code、Cursor 中查看，也可以交给 Agent 分析。
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=sunneeyang.gridiff"><img alt="VS Code Marketplace" src="docs/images/badge-marketplace.svg"></a>
  <a href="https://open-vsx.org/extension/sunneeyang/gridiff"><img alt="Open VSX Registry" src="docs/images/badge-openvsx.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="docs/images/badge-license.svg"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#下载独立-cli-与完整技能包">下载</a> ·
  <a href="#给-agent-使用">Agent / CLI</a> ·
  <a href="#主题与阅读布局">主题与布局</a> ·
  <a href="#配合-fork-使用">Fork 配置</a> ·
  <a href="docs/INSTALL.md">安装指南</a> ·
  <a href="docs/USAGE.md">使用手册</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/preview-dark.png">
  <img src="docs/images/preview-light.png" alt="Gridiff 0.1.18 原表对照：XLSX 中铁剑价格从 100 改为 120，法杖需求等级从 5 改为 8，木盾删除，皮甲新增。" width="1080">
</picture>

<p align="center"><sub>0.1.18 实际界面 · 虚构 XLSX 数据 · GitHub 组件风格与配色 · 精密矩阵布局</sub></p>

Gridiff 按主键对齐记录、按字段名对齐列，让你直接看到“哪条记录的哪个字段，从什么值改成了什么值”。适合游戏配置、策划表和 Excel 工作簿审阅，比较过程只读，不改写源文件，也不上传表格数据。

例如：**“看看装备表这次改了什么，有没有顺手改到不该改的地方。”** 你可以在 Fork 中选中本地修改或历史提交打开对比，也可以让 Agent 找出价格变化、意外的等级改动和整条记录的增删，再结合项目规则解释。

**当前版本：0.1.18。** [更新记录](CHANGELOG.md) · [CLI / VSIX 发布页](https://github.com/SunneeYang/gridiff/releases/tag/v0.1.18) · [完整 Agent 技能发布页](https://github.com/SunneeYang/gridiff/releases/tag/skill-v0.1.18)

## 为什么用 Gridiff

- **按表格理解变化**：插入一行或调整列顺序后，仍可按主键和字段名查看对应记录。
- **保留阅读上下文**：新增、删除、修改按源表顺序放在一起；未变化的单元格弱化显示。
- **适配配置表**：支持普通表头、自定义多行表头、Mova 四行表头与竖表；保留文本前导零和长 ID。
- **缩小审阅范围**：搜索当前工作表全部记录，筛选变动记录与字段，按页查看；XLSX 可选择首表、全部表或指定表。
- **选择熟悉的环境**：独立程序在默认浏览器展示，扩展在 VS Code / Cursor 中独立运行。网页和插件均可切换组件风格与阅读布局。网页另有五套配色和系统/浅色/深色；插件配色跟随编辑器。

## 快速开始

先选择使用方式：

| 使用方式 | 安装与打开 |
| --- | --- |
| **VS Code** | 在扩展面板搜索 `@id:sunneeyang.gridiff`，安装 **Gridiff — Visual Table Diff**，然后打开 CSV 或 XLSX 差异。 |
| **Cursor** | 在 Cursor 扩展面板搜索同一扩展 ID；搜索不到时，从 [Open VSX](https://open-vsx.org/extension/sunneeyang/gridiff) 下载 VSIX，通过 **Install from VSIX…** 安装。 |
| **浏览器 / 独立 CLI** | 下载下方对应平台的 **CLI ZIP**，解压后传入两份文件，或配置为 Fork 外部对比工具。无需编辑器、Node.js 或 Go。 |
| **Agent** | 下载对应平台的 **完整技能 ZIP**，其中已包含 CLI；可直接把下方[安装提示词](#给-agent-使用)发给 Agent。 |

确认扩展发布者为 **sunneeyang**。编辑器扩展无需安装独立 Gridiff 程序；仅打开单个文件不会启动对比。

> **第一次使用？** 从下方下载表或 [安装说明](docs/INSTALL.md) 开始。使用团队分发目录时，还可打开 [离线 Fork 配置指南](安装与使用.html)，按系统和工具查看步骤、复制参数。单独下载指南时须保留 `docs/guide/` 资源目录；GitHub 直接打开 HTML 会显示源码。

团队仓库已经提供 `gridiff/` 时，也可更新仓库及 Git LFS 文件后，打开其中的 **安装与使用.html**。公共下载和技能安装均可独立完成。源码构建与团队分发见 [开发文档](DEVELOPMENT.md#独立程序)。

### 下载独立 CLI 与完整技能包

以下为 **0.1.18** 的发布附件。按程序实际运行的系统和 CPU 选择；Agent 在远程主机、容器或 WSL 内执行时，以该环境为准。

| 平台 | 独立 CLI | 完整 Agent 技能（内置 CLI） |
| --- | --- | --- |
| macOS Apple Silicon | [CLI ZIP](https://github.com/SunneeYang/gridiff/releases/download/v0.1.18/gridiff-darwin-arm64.zip) | [技能 ZIP](https://github.com/SunneeYang/gridiff/releases/download/skill-v0.1.18/gridiff-darwin-arm64.zip) |
| macOS Intel | [CLI ZIP](https://github.com/SunneeYang/gridiff/releases/download/v0.1.18/gridiff-darwin-x64.zip) | [技能 ZIP](https://github.com/SunneeYang/gridiff/releases/download/skill-v0.1.18/gridiff-darwin-x64.zip) |
| Linux ARM64 | [CLI ZIP](https://github.com/SunneeYang/gridiff/releases/download/v0.1.18/gridiff-linux-arm64.zip) | [技能 ZIP](https://github.com/SunneeYang/gridiff/releases/download/skill-v0.1.18/gridiff-linux-arm64.zip) |
| Linux x64 | [CLI ZIP](https://github.com/SunneeYang/gridiff/releases/download/v0.1.18/gridiff-linux-x64.zip) | [技能 ZIP](https://github.com/SunneeYang/gridiff/releases/download/skill-v0.1.18/gridiff-linux-x64.zip) |
| Windows x64 | [CLI ZIP](https://github.com/SunneeYang/gridiff/releases/download/v0.1.18/gridiff-windows-x64.zip) | [技能 ZIP](https://github.com/SunneeYang/gridiff/releases/download/skill-v0.1.18/gridiff-windows-x64.zip) |

两个发布页分别提供 `SHA256SUMS.txt`。CLI ZIP 解压后直接得到 `gridiff`（Windows 为 `gridiff.exe`）；完整技能 ZIP 内是包含 `SKILL.md`、引用文档和 `bin/` 的 `gridiff/` 目录。GitHub 的 **Source code** 压缩包不含可执行程序。

macOS / Linux 在 CLI 解压目录运行：

```sh
./gridiff "旧版本.xlsx" "新版本.xlsx"
```

Windows PowerShell 使用 `& ".\gridiff.exe" "旧版本.xlsx" "新版本.xlsx"`。默认打开浏览器对比；生成 JSON 文件用下面的报告参数。

## 给 Agent 使用

把这句话发给 Codex、Cursor 或其他支持本地技能的 Agent：

> 请从 https://github.com/SunneeYang/gridiff 安装 Gridiff skill，按仓库 README 和 Agent 安装说明选择当前平台的完整技能包，并验证 XLSX 对比。

安装后可以直接说：

- “帮我看看还没提交的 Excel 表格都改了什么。”
- “看看装备表上次提交改了哪些地方。”
- “这次应该只改价格，帮我检查有没有改到别的内容。”

Agent 比较 CSV/XLSX，或审查包含这些文件的配置改动时，按 [Gridiff 技能说明](skills/gridiff/SKILL.md) 准备输入和解读结果；已安装时优先读取安装目录内的 `SKILL.md`，以该目录定位程序。技能包包含对应平台的 CLI，解压后将其中的 `gridiff/` 放入所用 agent 的技能目录即可；只有源码时，按 [开发说明](DEVELOPMENT.md#agent-技能包) 生成完整包。

从 GitHub 安装时，读取 [Agent 安装说明](docs/AGENT-INSTALL.md)，选择对应平台的完整技能包；技能独立于 Design 等业务仓库。当前 Codex、Cursor 可共享 `~/.agents/skills/gridiff/` 的一份安装。不要只通过 GitHub 技能安装器复制 `skills/gridiff/` 源码目录，其中没有 CLI。

1. **定位程序并确认方向**。从已安装技能目录调用 `bin/gridiff`，Windows 使用 `bin/gridiff.exe`，无需配置 PATH；先用包内程序的 `--help` 确认参数。旧版本在前，新版本在后。
2. **生成报告**。日常分析用 `--temp-output`，CLI 自动选择平台用户缓存目录并返回一行实际文件路径。用户要求留档时改用 `--output <文件>`，两种输出模式互斥。
3. **读取文件后得出结论**。CLI 退出后，用文件读取工具打开返回的路径；终端输出仅是文件路径，实际差异在 JSON 文件内。先看统计，再读取记录、字段和旧新值，同时核查值、字段结构及顺序变化。完整报告包含未变化记录，大文件只读了一部分时，结论也仅覆盖已核查部分。

下面以 macOS/Linux 的技能包路径举例；Windows 使用 `bin/gridiff.exe`，PowerShell 通过 `&` 调用带引号的程序路径：

```sh
"<技能目录>/bin/gridiff" --temp-output "旧版本.xlsx" "新版本.xlsx"
"<技能目录>/bin/gridiff" --temp-output --key id --key profession "旧版本.csv" "新版本.csv"
"<技能目录>/bin/gridiff" --output "差异报告.json" "旧版本.xlsx" "新版本.xlsx"
```

**成功条件是退出码为 `0` 且报告 `complete: true`。** 非零退出时若仍返回报告路径，应读取其中的诊断；`complete: false` 或某张表失败不能当作无变化。解读字段、结构和类型变化前，读取 [JSON 报告约定](skills/gridiff/references/report.md)。

XLSX 默认只比较首表，扩大范围须显式使用 `--sheets all` 或 `--sheet 名称`；核对报告中的实际范围、格式、主键与对齐方式，再结合项目代码解释业务含义。公式只使用保存的缓存结果。临时报告保留 72 小时，由后续临时调用回收；指定保存路径的报告不自动清理。完整参数与各平台缓存目录见 [命令行报告](docs/USAGE.md#命令行报告)。

审查工作区、暂存区或提交/分支改动时，先读取 [Git 范围与快照规则](skills/gridiff/references/git.md)，明确基线并准备原始字节快照，再逐份比较；最终列明成功、失败和跳过的文件。

## 配合 Fork 使用

在 Fork 的 **Settings / Preferences → Integration → External Diff Tool** 中配置一次。Fork 支持 macOS 和 Windows；Linux 可从终端或编辑器独立使用 Gridiff。

| 目标工具 | Fork 中的选择 / File Path | Arguments |
| --- | --- | --- |
| **VS Code** | 选择内置 **VSCode / Visual Studio Code** | 使用内置配置 |
| **Cursor** | 选择自定义工具，定位 Cursor 的命令行入口 | `--wait --diff $REMOTE $LOCAL` |
| **下载的独立 CLI** | 选择自定义工具，定位解压后的 `gridiff`；Windows 选择 `gridiff.exe` | `$REMOTE $LOCAL` |
| **团队仓库自带 Gridiff** | 选择自定义工具，定位 `<仓库>/gridiff/gridiff`；Windows 选择 `gridiff.cmd` | `$REMOTE $LOCAL` |

**所有入口统一为旧文件在前、新文件在后。** Fork 自定义工具必须按上表填写顺序，占位符不要加引号；Merge Tool 保持原设置。完整步骤与快捷键见 [安装说明](docs/INSTALL.md)，按系统展示的文件选择步骤和配图见 [离线图文指南](安装与使用.html)。

在含有独立可执行程序的目录，也可以直接调用：

```sh
./gridiff "旧版本.csv" "新版本.csv"
./gridiff --sheets all "旧版本.xlsx" "新版本.xlsx"
```

## 开始审阅

1. **保存表格**。在 Fork 选择提交或本地修改，再单击文件列表中的 CSV / XLSX，右键选择 **External Diff**。文件列表获得焦点后，也可用 macOS `⌘D` / Windows `Ctrl+D`。
2. **确认方向与对齐**。先核对顶部旧、新来源，再看“格式”和“主键”；通常保留自动识别即可。编辑器中也可运行 **Gridiff: 比较两个文件…**，依次选择旧、新版本。
3. **查看变化**。默认原表对照；搜索记录或旧新值，选择字段可查出整张表中涉及该字段的记录。“上一条 / 下一条”可跨页定位，上方统计始终表示当前表的全部变化。
4. **按需要逐条查看**。点击 **变更清单** 查看每条记录涉及的字段；在 **来源与设置** 中选择 **焦点审阅** 布局，可一边选择记录，一边看旧新值。回到 **原表对照** 则继续按表格阅读。

“字段”筛选只显示该字段有差异的记录和列，包含该字段涉及的新增、删除及结构变化。它与“仅看变动字段”的全表列并集规则不同；清除字段筛选即可恢复原来的列范围。焦点审阅按页列出记录队列，每次展示一条详情，不会把定位记录标记为已批准或已审查。

| 标记 | 含义 |
| --- | --- |
| **+ 新增** | 绿色新值，只展示新增内容 |
| **− 删除** | 红色旧值，只展示移除内容 |
| **~ 修改** | 同一单元格显示旧值、新值，并突出变化片段 |
| **灰色文字** | 未变化的值，保留阅读上下文 |

文件修改后，**网页模式从 Fork 再打开一次**，“重新计算”只使用已有快照；**插件模式点击“重新读取”**。审阅结束时，网页可点“结束比较”；插件经 Fork 的 `--wait` 启动时，还需关闭原始差异标签，Fork 才会结束等待。

## 主题与阅读布局

打开 **来源与设置 → 阅读与外观**，可以独立组合以下选项：

| 选项 | 可选内容 | 改变什么 |
| --- | --- | --- |
| 组件风格 | GitHub、Material、Soft UI、Neo Brutalist | 按钮、输入框、页签的边框、圆角、阴影等；默认 Material |
| 阅读布局 | 精密矩阵、纸面校对、焦点审阅、紧凑终端 | 信息间距、数据排布与阅读密度；默认精密矩阵 |
| 配色（浏览器） | 默认、GitHub、Catppuccin、Solarized、Nord | 界面和差异颜色；每套都有浅、深版本 |
| 明暗（浏览器） | 跟随系统、浅色、深色 | 默认跟随系统，也可手动固定 |

**外观设置保留当前视图、筛选、页码和选中记录，不重新计算差异。** 原表对照与变更清单通过各自按钮切换。两种视图均支持四种布局：纸面增加间距，终端紧凑并使用等宽字体；焦点在原表中并排显示旧新值，在清单中显示本页记录队列与单条详情。布局改变行高时，滚动偏移可能随之调整。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/preview-focus-dark.png">
  <img src="docs/images/preview-focus-light.png" alt="变更清单的焦点审阅：左侧选择装备记录，右侧展示铁剑价格从 100 到 120，使用 Soft UI 组件风格和 Catppuccin 配色。" width="1080">
</picture>

<p align="center"><sub>变更清单 · 焦点审阅布局 · Soft UI 组件风格 · Catppuccin 配色</sub></p>

浏览器将四项外观偏好保存到系统配置目录，下次比较恢复；旧版配置自动兼容。VS Code / Cursor 提供相同的组件风格和阅读布局，保存在编辑器页面状态中，颜色与明暗跟随编辑器主题。设计来源与适配说明见 [组件风格方案](docs/design/style-design.md)。

## 支持范围

| 项目 | 当前行为 |
| --- | --- |
| 文件 | UTF-8 CSV、XLSX；只比较两份同格式文件，不支持 `.xls`、TSV 或加密工作簿 |
| 工作表 | **插件默认读取全部表，独立程序默认只读首表**；两者均可配置读取范围 |
| 公式 | 比较文件中保存的结果，不重算公式；字体、颜色、图表等排版变化不参与比较 |
| 独立程序平台 | macOS ARM64 / x64、Linux ARM64 / x64、Windows x64；未提供 Windows ARM64 原生程序 |
| 数据上限 | 单侧文件最多 8 MiB；XLSX 解压大小和单元格数量另有预算，见 [完整限制](docs/USAGE.md#当前限制) |

macOS ARM64 的 Fork CSV / XLSX 对比已验证；其余平台完成交叉构建，Windows、Linux 与远程工作区尚未完成实机验收。

## 项目文档

| 文档 | 内容 |
| --- | --- |
| [安装说明](docs/INSTALL.md) | 三种安装路线、Fork 配置、快捷键与常见问题 |
| [离线图文指南](安装与使用.html) | 下载后本地打开，按系统与工具逐步操作 |
| [使用与配置](docs/USAGE.md) | 主键、表头、Mova 规则、XLSX 语义、筛选分页与限制 |
| [Agent 技能](skills/gridiff/SKILL.md) | Agent 调用流程，以及 Git 快照和 JSON 报告的解读入口 |
| [Agent 安装说明](docs/AGENT-INSTALL.md) | 从远程 Release 选择完整包、校验、安装和验证 |
| [插件说明](README.extension.md) | VS Code / Cursor 专用使用说明，也是 VSIX 的 README 来源 |
| [开发与发布](DEVELOPMENT.md) | 构建、测试、团队仓库同步与发布流程 |
| [性能记录](PERFORMANCE.md) | 测量方法、环境和优化结果 |
| [更新记录](CHANGELOG.md) | 版本变化 |

Gridiff 使用 [MIT 许可证](LICENSE)。问题或建议可提交到 [GitHub Issues](https://github.com/SunneeYang/gridiff/issues)。
