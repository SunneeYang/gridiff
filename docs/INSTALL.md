# Gridiff 安装与使用

建议第一次使用的同事打开图文指南：下载源码根目录的 **安装与使用.html** 和 `docs/guide/` 资源目录后，双击 HTML。团队的 design 仓库已同步指南时，直接打开与 README 同级的 **gridiff/安装与使用.html**。

指南按系统和工具显示步骤，可复制参数、查看配图、回看快捷键。离线即可阅读；安装编辑器扩展需要联网。GitHub 中直接点 HTML 会显示源码，不会运行交互页面。

指南顶部可选择 **跟随系统 / 浅色 / 深色**，默认跟随系统并自动响应系统明暗变化；**配色**提供 Cobalt、Nord、Solarized，每套都有明暗版本。手动选择会保存在当前浏览器；浏览器禁止本地存储时，切换仍对当前页面有效。

## 选择一种方式

| 你想在哪里查看 | 需要安装什么 | Fork 外部 Diff 工具 |
| --- | --- | --- |
| 默认浏览器（推荐团队成员） | 更新 design 仓库及 Git LFS 文件，不需编辑器或插件 | 自定义，选择 `gridiff/gridiff`；Windows 选择 `gridiff/gridiff.cmd`，参数 `$REMOTE $LOCAL` |
| VS Code | 安装 VS Code，在扩展面板搜索 `@id:sunneeyang.gridiff` 并安装 | 选择内置 **VSCode**，不手填参数 |
| Cursor | 安装 Cursor，在其扩展面板搜索 `@id:sunneeyang.gridiff` 并安装 | 自定义，选择 Cursor 的命令行入口，参数 `--wait --diff $REMOTE $LOCAL` |

确认扩展名为 **Gridiff — Visual Table Diff**、发布者为 **sunneeyang**。若编辑器市场搜索不到，可从 [Open VSX](https://open-vsx.org/extension/sunneeyang/gridiff) 下载 VSIX，再用扩展面板的 **Install from VSIX…（从 VSIX 安装）**。VS Code 的官方市场页面是 [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=sunneeyang.gridiff)。

配置位置是 Fork 的 **Integration → External Diff Tool**。Windows 的集成页可能使用工具列表：添加并选择工具后，还需确认它是默认 / Primary 工具，部分版本要右键设为默认。选择文件时优先使用文件夹按钮，不要把示例路径原样当成自己的安装位置。合并工具 **Merge Tool** 保持原设置。

所有方式都遵循“旧版本 → 新版本”。Fork 自定义工具的文件参数使用 `$REMOTE $LOCAL`，不要保留默认的反向顺序。

## 开始一次比较

1. 保存 Excel 或 CSV 文件；在 Fork 中打开所属仓库。
2. 比较历史时，选中提交，再在下方文件列表中选择 `.csv` 或 `.xlsx`；比较未提交修改时，在 **Local Changes** 中选择文件。
3. 右键选择 **External Diff（外部 Diff）**。在文件列表已获得焦点时，也可按 macOS **⌘D** / Windows **Ctrl+D**。
4. Gridiff 自动打开表格；先看顶部的旧、新路径和变动数量，再核对格式与主键。

绿色“+ 新增”只有新值，红色“− 删除”只有旧值；修改的单元格同时显示旧值和新值，没变化的值会弱化。搜索框查询当前工作表全部记录；浏览器自带的查找仅覆盖当前页面，不能代替它。分页只控制当前展示范围，不会漏掉后续记录。

独立程序默认只读取 XLSX 第一张工作表；插件默认读取全部表。Mova 用户可在编辑器设置中搜索 **Gridiff Xlsx Sheets** 并改为 `first`。工作表下拉框只能切换已加载的表。公式比较保存的结果，不重新计算。

文件修改后，网页模式需从 Fork 再打开一次；**重新计算**只使用已读入的数据。插件可点击 **重新读取**。

## 常用快捷键

| 操作 | macOS | Windows |
| --- | --- | --- |
| Fork 设置 | ⌘, | Ctrl+, |
| Fork 外部 Diff（先单击选中文件列表里的文件） | ⌘D | Ctrl+D |
| 编辑器扩展面板 | ⌘⇧X | Ctrl+Shift+X |
| 编辑器命令面板 | ⌘⇧P | Ctrl+Shift+P |
| 复制选中文字 | ⌘C | Ctrl+C |
| 关闭当前标签页 | ⌘W | Ctrl+W |

Gridiff 没有专用快捷键；可用 **Tab / Shift+Tab** 在控件间移动，用 **Enter / 空格**操作按钮和选项。Fork 的 ⌘D 依赖焦点，当前版本在提交列表可能用于折叠详情；先单击文件列表，或始终使用右键菜单。

审阅完网页模式时，点击 **结束比较**释放当前会话。插件模式通过 Fork 的 `--wait` 打开时，还需关闭原始差异标签，Fork 才会结束等待；仅关闭 Gridiff 表格标签不够。

## 常见问题

- **新增变成删除**：检查自定义工具参数是否是 `$REMOTE $LOCAL`；Cursor 前面还需有 `--wait --diff`。可暂时点击“交换左右”反向查看，但应修正 Fork 配置。
- **打开文本或二进制差异**：确认对应编辑器已安装且启用扩展；在设置搜索 Gridiff，启用 **Auto Open Diff**。也可从命令面板运行 **Gridiff: 以表格方式查看当前差异**。
- **主键报错**：先检查表头格式，再选唯一且非空的主键。按行号对齐可临时查看，插入或删除行会影响后续对齐。
- **程序是 LFS 指针或找不到程序**：在 design 仓库拉取 Git LFS 文件，或请维护仓库的同事协助。不要把 `bin/` 中某个 CPU 版本当作统一入口。
- **不支持的文件**：只比较两份 CSV 或两份 XLSX。网页模式会提示不支持；其他文件可在 Fork 内置视图查看。
- **Linux / Windows ARM64**：Fork 没有 Linux 版，可在 Linux 终端运行独立 Gridiff 或在编辑器独立比较。当前独立程序提供 macOS/Linux ARM64、x64 和 Windows x64；未提供 Windows ARM64 原生程序。

## Fork 能否一条命令自动配置？

本机核验的 **Fork Command Line Tools v4** 公开命令是 `open`、`status` / `commit`、`log` 等，没有外部 Diff 配置命令。指南采用设置界面完成一次配置。`git config diff.tool` 不是 Fork 的外部工具设置入口，不用它替代。

浏览器可以辅助识别系统，不能可靠读取本机已安装的应用、仓库位置或修改 Fork 配置。指南的系统预选和路径建议都可以手动更改。

快捷键依据：[Fork macOS 官方更新记录](https://fork.dev/releasenotes)、[Fork Windows 官方快捷键表](https://github.com/fork-dev/TrackerWin/issues/333)。Windows 设置界面差异参考 [TrackerWin #2762](https://github.com/fork-dev/TrackerWin/issues/2762)；该界面未做 Windows 实机验证。
