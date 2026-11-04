# 从 GitHub 安装 Gridiff 技能

本说明供 Agent 执行安装。唯一来源为 [SunneeYang/gridiff](https://github.com/SunneeYang/gridiff)，技能独立于 Design 等业务仓库。完整技能包内包含 CLI，无需另装 Node.js、Go、编辑器扩展或全局 Gridiff 命令。

## 1. 确定执行环境和安装位置

选择实际运行 CLI 的系统和 CPU。在 SSH、容器、WSL 或云端运行的 Agent，应在该环境内安装。macOS/Linux 用 `uname -s`、`uname -m` 核对；Windows PowerShell 可用 `[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture` 核对系统架构。

| 执行环境 | 完整技能包文件名 |
| --- | --- |
| macOS Apple Silicon | `gridiff-darwin-arm64.zip` |
| macOS Intel | `gridiff-darwin-x64.zip` |
| Linux ARM64 / aarch64 | `gridiff-linux-arm64.zip` |
| Linux x86_64 | `gridiff-linux-x64.zip` |
| Windows x64 | `gridiff-windows-x64.zip` |

目前不提供 Windows ARM64 原生程序。没有对应平台时停止安装并说明原因，不静默选择其他架构。

默认安装为当前用户的技能；用户指定仅供本项目使用时，选择项目级目录。

| Agent | 用户级技能根目录 | 项目级技能根目录 |
| --- | --- | --- |
| Codex | `~/.agents/skills` | `<项目根目录>/.agents/skills` |
| Cursor | `~/.agents/skills`（也支持 `~/.cursor/skills`） | `<项目根目录>/.agents/skills`（也支持 `.cursor/skills`） |
| 其他支持 `SKILL.md` 的 Agent | 按该宿主当前文档选择 | 按该宿主当前文档选择 |

Codex、Cursor 可共享 `.agents/skills` 中的一份安装。`~` 指执行环境的用户主目录，PowerShell 使用 `$HOME`。其他 Agent 需支持 `SKILL.md`、本地命令执行及文件读取。

目录规则来源：[Codex 本地技能](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)、[Cursor 技能目录](https://cursor.com/docs/skills#skill-directories)。宿主发现规则有变化时以其当前官方文档为准。

## 2. 下载并安装完整包

1. 查看 [GitHub Releases](https://github.com/SunneeYang/gridiff/releases)，选择包含当前平台完整技能 ZIP 的最新技能版本。包名见上表。只下载该 Release 实际列出的资产，记录版本和来源 URL；不要猜测尚未发布的下载地址。独立 CLI ZIP、VSIX 和 GitHub 自动生成的源码 ZIP 均不是完整技能包。
2. 在任务专属临时目录下载和解压。完整包必须包含 `gridiff/SKILL.md`、`gridiff/references/`、`gridiff/bin/gridiff`（Windows 为 `gridiff.exe`）、构建记录、`LICENSES.txt` 及 `manifest.json`。只有说明没有程序时不要继续安装。
3. 核对 `manifest.json` 的 `name: gridiff`、平台 `target`、版本及 `cli` 路径，并逐项校验 `files` 中的 SHA-256。使用 `shasum -a 256`、`sha256sum` 或 PowerShell `Get-FileHash -Algorithm SHA256` 均可。读取 `bin/gridiff.json`（Windows 为 `gridiff.exe.json`），核对平台、版本及程序哈希与清单一致。若 Release 提供归档校验和，也核对下载 ZIP 的 SHA-256。
4. 将包内整个 `gridiff/` 放到第 1 节选定的技能根目录，得到 `<技能根目录>/gridiff/SKILL.md`；不要多嵌套一层 `gridiff/`。目标目录已存在时，先检查版本和内容，相同文件可保留，升级时保留用户自定义内容，不覆盖未知修改。
5. macOS/Linux 保留 `bin/gridiff` 的执行权限，必要时用 `chmod +x` 恢复。通过绝对路径执行包内 CLI 的 `--help`，确认包含 `--temp-output` 和 `--output`。Windows PowerShell 用 `&` 调用带引号的 `bin/gridiff.exe` 路径。

源码中的 `skills/gridiff/` 仅包含技能说明和引用，不含 CLI。直接让通用 GitHub 技能安装器复制该目录，会得到不完整的安装。没有可用 Release 时，先检查是否已具备下面的源码构建环境；缺少工具链时报告缺口，不声称技能已安装成功。

### 尚无完整发布包时的源码构建

此路线需要已安装 Git、Node.js 22+、npm 和 Go 1.26+；仅在已有工具链的环境使用，不擅自安装系统依赖。将远程仓库克隆到任务专属工作目录，然后在仓库根目录执行：

```sh
git clone https://github.com/SunneeYang/gridiff.git
cd gridiff
npm ci --ignore-scripts
npm run build:skill -- --target darwin-arm64
```

按第 1 节替换 `--target` 为当前平台标识（ZIP 文件名去掉 `gridiff-` 和 `.zip`）。生成的 `dist/skills/gridiff-<平台>.zip` 是完整技能包，按上面的校验和安装步骤处理；记录实际源码提交及构建记录。安装后不依赖源码目录，可清理任务专属下载和构建文件。

## 3. 用 XLSX 验证调用和宿主发现

1. 读取安装目录内的 `SKILL.md` 及其引用的报告约定。准备两份小型 XLSX：第一张表包含 `id`、`price`，记录 `1` 的价格从 `100` 改为 `120`；第二张表另有一处变化，用于核对默认只读首表。只使用任务专属测试文件，不修改用户配置表。
2. 执行 `"<技能目录>/bin/gridiff" --temp-output "<旧.xlsx>" "<新.xlsx>"`；PowerShell 用 `&` 调用，Windows 程序名为 `gridiff.exe`。CLI 退出后，用文件读取工具打开 stdout 返回的实际报告路径。需要退出码 `0`、`complete: true`，并从实际记录和字段找到 `price: 100 → 120`；`sourceSheets` 应只列出双方首表。只看到路径或程序版本不算调用成功。
3. 再加 `--sheets all` 比较，读取新报告并确认第二张表的变化也出现。若不能准备 XLSX，明确报告 XLSX 验收尚未完成；CSV 冒烟检查不能代替此项。公式只比较已保存的缓存结果，不重新计算。
4. 确认宿主列出了 `gridiff` 技能。Codex 若本轮尚未发现，重新进入会话检查；Cursor 在启动时发现，可重新打开后在 Agent 聊天的 `/` 菜单或 Customize → Skills 查找。其他宿主按其发现/刷新规则检查。未观察到技能列表时明确说明，不将文件复制成功等同于宿主已加载。

日常比较默认使用 `--temp-output`。CLI 在各平台的用户缓存目录自动分配报告路径，保留 72 小时，由后续临时调用回收；不需要 Agent 自行生成缓存地址。用户要求留档时改用 `--output "<文件.json>"`，该文件不会自动清理。旧文件在前、新文件在后。

完成后清理任务专属下载和样例，报告安装路径、宿主、平台、包版本与来源、XLSX 验收结果及宿主发现情况。结合项目代码解释差异时，区分报告事实与业务推断。
