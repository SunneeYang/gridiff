# Gridiff 开发与发布

本文件供源码维护者使用，不随 VSIX 分发。面向用户的说明放在 README.md。

## 开发环境

使用 Node.js 20+、npm 和 VS Code 1.85+。插件使用原生 JavaScript 和 VS Code API，没有运行时 npm 依赖，无需打包 JavaScript。

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:ui
npm run package
```

在配置了 Codex 临时目录 harness 的环境中，依赖安装、测试和打包通过 `agent-tmp-run` 执行。VSIX 和界面截图写入被 Git 忽略的 `dist/`。

## 验证

- `test/core.test.js` 和 `test/extension.test.js` 验证 CSV、记录对齐、比较结果和 VS Code 交互。
- `test/ui.cjs` 默认使用已安装的 Chrome；可用 `PLAYWRIGHT_CHANNEL` 选择其他 Playwright 浏览器通道。验证两种视图、筛选、分页、长文本、安全文本展示、滚动及浅色/深色布局。
- 在 VS Code 中按 F5 可运行开发宿主。`test/fixtures/before.csv` 和 `after.csv` 是演示数据，不随扩展分发。
- `test/host/index.js` 通过 `--extensionTestsPath` 运行，同时指定 `--extensionDevelopmentPath`。必须使用隔离的 `--user-data-dir` 和 `--extensions-dir`，测试会修改隔离配置。覆盖启动激活、自动打开、保留原差异、关闭不反弹、配置开关、手动入口、文本回退和 Git HEAD。

宿主测试通过不等于 Fork、其他操作系统或远程工作区的实机验收；分别记录验证范围。

## 比较和显示约定

记录以新 CSV 的顺序为主。删除块放在下一个仍存在的旧记录之前，尾部删除放在旧表最后一个仍存在的记录之后；没有共同记录时，先显示旧表删除，再显示新表新增。顺序变化提示不是最少移动操作数。

变动列按整次比较计算，包含新增行非空字段和已有行变更字段（包括字段增删造成的单元格变化）。删除行不扩大集合；只有删除而没有新增或已有单元格变化时，使用删除行的非空字段。空字符串和不存在的字段不算有值，`0` 和空格算有值。搜索、分页不改变列集合。

页面先过滤记录，再按原顺序分页。每页行数为 `max(1, min(100, floor(3000 / max(1, 显示字段数))))`；固定记录标识列不计入字段数。这是固定限制，不是动态性能检测。

比较始终保留原字符串。数值增减提示跳过超出安全精度的值；百分比以旧值绝对值为分母，旧值为零时省略。CSV 内容不写入 Webview 持久状态。

## 发布

1. 保持扩展 ID `sunneeyang.gridiff` 不变，递增 `package.json` 和 `package-lock.json` 中的版本号。
2. 更新用户说明；按改动范围运行验证。仅改文档时核对 Markdown、链接和最终安装包，不必重复运行全部界面测试。
3. 运行 `npm run package`，检查包内的发布者、版本、MIT 许可证和 README。排除测试数据、截图、开发依赖及本文件。
4. 在 Marketplace 管理页选择发布者 `sunneeyang`，上传新 VSIX。发布者必须与包内 `publisher` 一致。
5. 等待市场验证，确认公开页面显示新版本和新说明。上传成功、市场可安装和客户端实际更新是不同状态。

README 是市场详情的来源，修改本地文件不会直接更新已上架页面，需要重新打包和发布。没有公开源码仓库时，不在 README 中使用依赖仓库地址的相对图片或文档链接。

`package.json` 中的 `private: true` 用于防止误发到 npm，不影响 VS Code Marketplace 发布。许可证检查已开启，不使用 `--skip-license`。

开发依赖的安全检查使用 `npm audit`。此前打包工具的 Azure 登录依赖链报告过涉及 uuid 的中危告警；复核时以当前扫描为准，不把旧告警数量写成固定结论。开发依赖不进入 VSIX，不使用跨主版本覆盖强行消除告警。
