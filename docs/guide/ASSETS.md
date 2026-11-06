# 图片来源与维护

- `assets/fork-custom-default.png`：用户在本线程提供的 macOS Fork“Edit Diff Tool”真实截图。图中为默认空路径和 `$LOCAL $REMOTE`，只用于说明字段位置。指南必须明确要求以页面给出的参数替换它，不能标成正确配置后的截图。Windows 的界面不同，不将此图冒充 Windows 截图。
- `assets/gridiff-example.png`：2026-11-07 使用已发布的 Gridiff 0.1.18 和虚构 XLSX 装备表渲染的实际界面截图，与 README 的浅色预览相同，包含新增、删除和修改；截图不含本机来源路径、业务表或账号信息。
- `../images/preview-light.png`、`preview-dark.png`：同次生成的原表对照，使用 GitHub 组件风格、GitHub 配色和精密矩阵布局。`preview-focus-light.png`、`preview-focus-dark.png`：同一组数据的变更清单，使用 Soft UI 组件风格、Catppuccin 配色和焦点审阅布局。均由正式 CLI 页面直接截图。

源码根目录的 `安装与使用.html` 引用本资源目录；策划库中使用 `gridiff/安装与使用.html` 和 `gridiff/guide/`。保留 HTML 与资源目录的相对位置才能离线打开。修改资源列表时，同时更新 `scripts/sync-project.js` 的 `guideFiles` 和同步检查。

Windows 的 Fork 设置流程依据公开文档和问题记录，目前没有 Windows 实机截图。浏览器不能检测本机安装状态；页面不能将推断显示为“安装成功”。
