# Gridiff 五套配色方案

> 本文件记录原型阶段；后续正式页面接入与验证见[正式差异页面接入](production-integration.md)。
本文件只描述颜色系统。组件风格已另行补充到[四种风格方案](style-design.md)：GitHub、Material、Soft UI和Neo Brutalist。组件风格、阅读布局与配色在同一个原型中独立切换。

2026-11-06，基于 `main@f781946`。范围是浏览器差异页面的设计方案与[交互原型](diff-review-prototype.html)，尚未修改正式页面、偏好协议、CLI 二进制或插件。

## 设计结果

保留 `default / github / catppuccin / solarized / nord` 五个配色 ID，每套分别设计浅色、深色，共十种组合。配色只改变表面温度、灰阶层级与交互色；布局、字号和密度由独立的风格选项决定。配色切换不会改变数据、筛选、工作表或当前定位。

| 配色 | 设计定位 | 浅色表面 / 正文 / 交互 | 深色表面 / 正文 / 交互 |
| --- | --- | --- | --- |
| 默认：石墨 | 最中性的基准，钢蓝交互，把注意力留给配置值 | `#fbfcfd` / `#242933` / `#394b63` | `#1b1f26` / `#e7eaf0` / `#b5c9e8` |
| GitHub：清晰 | 白与冷灰、鲜明蓝色，接近熟悉的代码审查语境 | `#ffffff` / `#1f2328` / `#0864ce` | `#0d1117` / `#e6edf3` / `#79c0ff` |
| Catppuccin：柔紫 | Latte/Mocha 的紫灰基础，浅深统一使用 mauve 方向 | `#eff1f5` / `#4c4f69` / `#7c31dc` | `#1e1e2e` / `#cdd6f4` / `#cba6f7` |
| Solarized：暖纸 | 暖纸与青墨，通过蓝青色操作与红绿差异保持区分 | `#fdf6e3` / `#40575e` / `#006395` | `#002b36` / `#d4d8c8` / `#80c7d8` |
| Nord：冷雾 | 雪灰与极夜蓝，低饱和冰蓝交互，差异保有足够强度 | `#eceff4` / `#2e3440` / `#3f6382` | `#2e3440` / `#eceff4` / `#9acbda` |

以上均为 **Gridiff 的最终适配值**，不声称与上游官方 token 完全相同，也不据配色宣称“护眼”或降低疲劳的实验效果。默认与 GitHub 不再共用近似的蓝色强调；Catppuccin 浅深色保持同一紫色方向；Catppuccin 深色弹层改为比表面更亮，避免原先层级相反。

原型上方用四个独立下拉框选择组件主题、阅读布局、五套配色及“跟随系统 / 浅色 / 深色”；四套组件试样按需展开，底部可展开颜色角色及十种配色的并排样本。评审控制区与色值图例只属于设计原型，不占用正式产品常驻工具栏；正式外观入口仍归入“来源与设置”。原型不写入本机真实偏好。

## 统一的颜色角色

每种模式定义 20 个角色，完整值只有一处：原型 HTML 的 `script#palette-data`。检查脚本直接读取这里，避免文档中的部分色值表成为第二套实现数据。

| 角色 | 用途与边界 |
| --- | --- |
| `bg / surface / elevated` | 表体、表头/次级区域、设置弹层。深色按层级逐级变亮；不把浅色直接反相。 |
| `fg / muted` | 正文与旧新值 / 技术标识和弱化内容。必要信息不能靠降低到不可读的对比度来弱化。 |
| `line / control` | 装饰分隔线 / 识别输入控件边界。两者分开，表格不必处处用粗重边框。 |
| `hover` | 悬停行的中性背景。旧新值区域仍覆盖自己的差异底色。 |
| `accent / selection / selection-fg / focus` | 操作文字、选择底色、选择文字、键盘或记录定位边界。选择记录不覆盖新增/删除颜色。 |
| `add / add-bg / add-mark` | 新增文字或“新”标签、轻底色、字符级强标记。 |
| `remove / remove-bg / remove-mark` | 删除文字或“旧”标签、轻底色、字符级强标记。 |
| `modify / modify-bg` | “修改”文字与轻背景。不把整行刷成强烈黄色。 |

状态规则：

- 旧值始终在前、新值在后，均保留文字标签。新增、删除、修改、仅字段变化仍用文字表达，不依赖红绿辨别。
- 单元格底色比字符高亮轻，字符高亮不降低正文对比；缺失/不存在使用正文色。
- 焦点至少 2px，独立于差异色；禁用态同时改变背景、文字、指针，并有真实 `disabled` 属性。
- 输入框、复选框、文本选择、滚动条、展开内容、空状态和错误文案都使用相同的语义角色。没有加载动效，减弱动态效果偏好不会影响内容。
- 五套配色共用语义角色；字体、字号、密度和阅读结构由[风格方案](style-design.md)决定。单独切换配色不改变这些属性，不引入渐变、光晕或装饰性品牌素材。
- 外层评审工具跟随宿主；独立打开时有系统深色回退。选择某套配色只改变产品样本区域。宿主 UI 变量不会覆盖样本内已经选择的配色。

## StyleKit 与官方色盘来源

StyleKit 固定在 [`a979db1c4690988f7d718e1dd1c1a251ebc97941`](https://github.com/AnxForever/stylekit/tree/a979db1c4690988f7d718e1dd1c1a251ebc97941)。已查验其 [meta registry](https://github.com/AnxForever/stylekit/blob/a979db1c4690988f7d718e1dd1c1a251ebc97941/lib/styles/meta-registry.ts)、[style registry](https://github.com/AnxForever/stylekit/blob/a979db1c4690988f7d718e1dd1c1a251ebc97941/lib/styles/registry.ts) 与 [design-spec registry](https://github.com/AnxForever/stylekit/blob/a979db1c4690988f7d718e1dd1c1a251ebc97941/lib/design-spec/registry.ts)：五个现有名称中只有 `github-style` 有直接对应；其余不能归称为 StyleKit 原生主题。

| 资料 | 实际采用 | 不直接复制的部分 |
| --- | --- | --- |
| [StyleKit GitHub spec](https://github.com/AnxForever/stylekit/blob/a979db1c4690988f7d718e1dd1c1a251ebc97941/lib/design-spec/samples/github-style.ts)、[input recipe](https://github.com/AnxForever/stylekit/blob/a979db1c4690988f7d718e1dd1c1a251ebc97941/lib/recipes/github-style.ts) | 角色分离、中性表面、细边界、明确焦点和禁用状态；作为五套主题共同的工作台规则 | 规格与 recipe 的主色/时长差异；不按品牌名称机械照搬全部组件 |
| [StyleKit Data Dense](https://github.com/AnxForever/stylekit/blob/a979db1c4690988f7d718e1dd1c1a251ebc97941/lib/design-spec/samples/data-dense.ts)、[Notion Style](https://github.com/AnxForever/stylekit/blob/a979db1c4690988f7d718e1dd1c1a251ebc97941/lib/design-spec/samples/notion-style.ts) | 紧凑扫描、数字对齐、悬停稳定、行内阅读 | KPI 卡片、极小中文、与表格无关的文档外观 |
| [StyleKit dark-mode](https://github.com/AnxForever/stylekit/blob/a979db1c4690988f7d718e1dd1c1a251ebc97941/lib/design-spec/samples/dark-mode.ts) | 有限的表面层级、边线和焦点分工 | glow、浮起动效、大圆角卡片和大块留白 |
| [Primer light](https://github.com/primer/primitives/blob/47736486bf67b2a14ba1ada61fa0f57af29bb875/src/tokens/base/color/light/light.json5)、[dark](https://github.com/primer/primitives/blob/47736486bf67b2a14ba1ada61fa0f57af29bb875/src/tokens/base/color/dark/dark.json5)、[functional roles](https://github.com/primer/primitives/blob/47736486bf67b2a14ba1ada61fa0f57af29bb875/src/tokens/functional/color/fgColor.json5) | 核实 GitHub 的浅深灰阶与独立前景角色；结合现有 Gridiff 和 StyleKit 适配 | 不声称当前原型是最新 Primer 的逐值复制 |
| [Catppuccin palette](https://github.com/catppuccin/palette/blob/07d02aa110ef9eb7e7427afca5c73ba9cf7f8ebd/palette.json) | Latte/Mocha 底色、文字和 mauve 身份 | 原始 green/yellow 不能直接作为浅色必要小字；统一 mauve 是本方案选择 |
| [Solarized 作者源](https://github.com/altercation/solarized/blob/62f656a02f93c5190a8753159e34b385588d5ff3/README.md#L202) | base3/base2 的暖纸与 base03/base02 的青墨 | 原始 base00 正文和蓝色链接不足以覆盖当前小字对比目标，需要适配 |
| [Nord 作者源](https://github.com/nordtheme/nord/blob/1cef71605416a222e57225b544540ce0fcec18d4/src/nord.css) | 雪灰/极夜基础，frost 操作、Aurora 状态色的用途 | 原始红绿不直接充当所有模式的小字；完整浅色角色映射由本方案设计 |

默认石墨是本次原创的 Gridiff 角色映射。其余命名色盘保留辨识度，但为阅读任务派生了边界、选择底、强高亮和必要的小字色。未复制 logo、字体文件、站点截图或组件库；没有引入运行时依赖。

## 验证与修正

可复现检查：

```sh
node docs/design/check-theme-palettes.cjs
```

该脚本验证五个 ID、十套完整角色、深色表面逐级变亮、强弱差异底不同，并检查 330 组实际使用的颜色配对。普通文字阈值 4.5:1，控件边界/焦点阈值 3:1；装饰网格线不按交互边界判定。

| 主题 | 浅色最低文字 / 控件 | 深色最低文字 / 控件 |
| --- | --- | --- |
| 默认 | 5.25 / 3.33 | 5.96 / 3.24 |
| GitHub | 4.84 / 3.49 | 5.76 / 3.34 |
| Catppuccin | 4.73 / 3.16 | 5.00 / 3.29 |
| Solarized | 4.53 / 3.13 | 4.78 / 3.30 |
| Nord | 4.68 / 3.18 | 4.55 / 3.21 |

第一轮数值检查确实发现 14 组不足：包括浅色主题在 hover 上的操作文字、部分字符强高亮上的正文、以及深色 Nord 的操作文字/控件边界。已对具体角色加深、提亮或减轻强底色；上述结果是修正后的最低值，不能当成所有设备、视力状况或所有渲染组合的认证。

浏览器中另执行 70 条断言，逐套验证实际计算颜色正确进入表面、正文、旧新底色、字符高亮与记录定位；切换十种组合时价格筛选和当前定位保持不变。实际媒体偏好模拟验证“跟随系统变深 → 手动浅色保持浅色 → 切回系统恢复深色”。

视觉检查包含完整默认表格、十个并排样本、390px 深色 Nord，以及独立审查的桌面和窄屏设置展开。修正了主题选择器的选中态辅助字对比、独立深色浏览器中外层说明文字的回退。已有表格导航、长文本与原型错误/加载状态继续复用。

独立评审结论为“在原型范围内可交付”：五套主题的手动/系统明暗、切换时保留筛选/定位、390px 设置面板，以及深色外层文字修复均已复核。悬停不覆盖差异底色由限定 CSS 与 DOM 角色检查支持，未对十种组合逐一执行鼠标悬停；结论不延伸到正式宿主集成。

Hallmark 静态扫描为 0 FAIL / 0 REFLEX / 0 WARN；其渲染检测因缺少 `puppeteer-core` 未执行，实际视觉检查使用 T3 HTML 渲染与浏览器。Impeccable 扫描保留两项建议：统计容器内边距与紧凑标题比例；子内容已有内边距，标题比例符合 Operate 模式，本轮没有为消除扫描建议扩大控件区。

没有进行真实色觉障碍模拟或屏幕阅读器验收；用旧/新、状态名称与固定位置保留非颜色线索。没有更换差异算法；共同前后缀字符高亮的既有限制仍适用。

## 正式实现边界

浏览器比较页、VS Code Webview 和安装指南有三条独立主题路径：

- 浏览器：`media/themes.css` + `media/themes.js`。当前偏好只有 `mode` 和 `palette`，Go 保存到 `os.UserConfigDir()/gridiff/preferences.json`，支持跨端口恢复、迟到读取保护、串行保存及失败提示。保留五个 ID 即可保持已有选择的身份；本次原型不写这个文件。
- VS Code：通过 `media/main.css` 映射编辑器的 `--vscode-*`，不载入浏览器色盘。新增角色要保留对应宿主变量/回退，不能强行套用某一浏览器主题。
- 安装指南：有独立 Cobalt/Nord/Solarized 色盘与 `gridiff-guide-theme` localStorage，不和比较页同步；不在本次重设计范围内。

正式落地先补充强弱差异底、控件边界、选择与弹层角色，保持旧变量兼容，再把本方案的颜色映射到五套主题。随后扩展现有 `test/themes.cjs` 的实际渲染组合验证，并重建 CLI 内嵌资源。CSS 文件更新不等于已安装二进制或 VSIX 更新。

不增加任意自定义色值编辑器；用户本次要求的是重新设计现有主题。若以后需要该能力，前端白名单、Go 请求 schema、持久化兼容和验证都需一起设计。
