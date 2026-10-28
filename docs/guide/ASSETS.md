# 图片来源与维护

- `assets/fork-custom-default.png`：用户在本线程提供的 macOS Fork“Edit Diff Tool”真实截图。图中为默认空路径和 `$LOCAL $REMOTE`，只用于说明字段位置。指南必须明确要求以页面给出的参数替换它，不能标成正确配置后的截图。Windows 的界面不同，不将此图冒充 Windows 截图。
- `assets/gridiff-example.png`：2026-10-28 使用当前独立 Gridiff 程序和虚构 CSV 数据渲染的实际界面截图，包含新增、删除和修改。未使用业务表或账号信息。

指南的 CSS、脚本、图片均为相对路径；保持整个 `guide/` 目录才能离线打开。修改指南资源列表时，同时更新 `scripts/sync-project.js` 的 `guideFiles` 和同步检查。

Windows 的 Fork 设置流程依据公开文档和问题记录，目前没有 Windows 实机截图。浏览器不能检测本机安装状态；页面不能将推断显示为“安装成功”。
