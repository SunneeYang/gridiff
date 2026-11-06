# Gridiff 组件风格方案

> 本文件记录原型阶段；后续正式页面接入与验证见[正式差异页面接入](production-integration.md)。
2026-11-06。用户第二次纠正了方向：上一轮的矩阵、纸面、焦点和终端主要区分阅读布局，按钮、输入框和其他组件的表现仍然接近。它们不再被称为四种完整视觉主题。

本轮按 StyleKit 的真实组件配方，提供 **GitHub、Material、Soft UI、Neo Brutalist** 四种组件风格。[交互原型](diff-review-prototype.html)默认使用 Material + 原表矩阵 + 默认配色。顶部提供紧凑选择器，组件试样默认折叠在“比较四种组件风格”内；展开后可同色、同内容直接比较。点击“应用风格”后，下方真实控件与表格使用同一套CSS。试样的输入框明确为只读，实际搜索位于表格工具栏。

## 四套组件体系

| 组件 | GitHub | Material | Soft UI | Neo Brutalist |
| --- | --- | --- | --- | --- |
| 按钮 | 6px圆角、1px描边、灰底次按钮，轻微按压内影 | 胶囊实底主按钮、2px轻投影，次按钮描边；按下落平 | 16px圆角、无描边、柔和投影；hover上浮2px，按下回落并内凹 | 0圆角、2px结构描边、3px无模糊硬影；hover抬起，按下位移3px且收回阴影 |
| 输入/选择器闭合态 | 6px全框、1px边界，聚焦背景提亮 | 填充底、只有2px底线，上角8px、下角直角 | 16px无框输入、柔和内影，聚焦提亮 | 方角2px粗框，聚焦增加3px硬影，边框不变宽 |
| 页签 | 有外壳的紧凑分段控件 | 无分段外壳，底部指示线 | 圆润槽面、独立浮起的选中块 | 粗框分格、选中块反色 |
| 状态标签 | 细描边胶囊 | 实底小圆角块 | 无描边圆胶囊 | 方角粗描边块 |
| 表格/弹层 | 细线网格、明确边缘 | 12px圆角表面、轻投影、以横线分行 | 20px圆角表面、柔影、行内留白稍宽 | 方角粗外框、表头强分隔、硬投影 |

样本使用同一颜色，是为了检验组件本身是否可辨。GitHub 的绿色主按钮、Material 的蓝色、Soft UI 的靛蓝和 Neo 的荧光色没有被强行绑定；项目已有的[五套配色](theme-design.md)独立保留。这里是 Gridiff 适配，不能称为品牌官方组件或上游全部规则的逐字复刻。

## 阅读方式、风格和配色的边界

- **组件风格**只改变控件和表面的视觉、交互状态。切换时不重建表格DOM，也不改变布局、工作表、搜索、字段筛选、记录选择和表格滚动位置。
- **阅读布局**独立选择矩阵、纸面校对、焦点审阅、终端差异流；沿用此前四种renderer。更换阅读布局才会调整内容结构，保留当前筛选和记录身份。
- **配色与明暗**仍独立：五套配色，系统/浅色/深色。

同一主张的验收方式是：保持矩阵布局与默认配色，分别切换四种风格，观察实际按钮、输入框、页签、标签和表格，不能用另一种布局解释组件差异。

## StyleKit 来源

本轮重新读取仓库默认分支 `dev`，固定到 **`854eb466498bd7b96fce5730aa552df3843e0f7d`**。既读取设计说明，也核对组件配方和showcase实际代码；此前使用的`a979db1`只属于前轮研究。

| 风格 | 配方/规格 | 实际组件依据 |
| --- | --- | --- |
| GitHub | [recipe](https://github.com/AnxForever/stylekit/blob/854eb466498bd7b96fce5730aa552df3843e0f7d/lib/recipes/github-style.ts) | [分段tabs](https://github.com/AnxForever/stylekit/blob/854eb466498bd7b96fce5730aa552df3843e0f7d/app/styles/github-style/showcase/_content.tsx#L1150)、[输入与标签](https://github.com/AnxForever/stylekit/blob/854eb466498bd7b96fce5730aa552df3843e0f7d/app/styles/github-style/showcase/_content.tsx#L1231) |
| Material | [recipe](https://github.com/AnxForever/stylekit/blob/854eb466498bd7b96fce5730aa552df3843e0f7d/lib/recipes/material-design.ts) | [filled输入](https://github.com/AnxForever/stylekit/blob/854eb466498bd7b96fce5730aa552df3843e0f7d/app/styles/material-design/showcase/_content.tsx#L574)、[下划线tabs](https://github.com/AnxForever/stylekit/blob/854eb466498bd7b96fce5730aa552df3843e0f7d/app/styles/material-design/showcase/_content.tsx#L383) |
| Soft UI | [recipe](https://github.com/AnxForever/stylekit/blob/854eb466498bd7b96fce5730aa552df3843e0f7d/lib/recipes/soft-ui.ts)、[具体尺寸与按压状态](https://github.com/AnxForever/stylekit/blob/854eb466498bd7b96fce5730aa552df3843e0f7d/lib/design-spec/samples/soft-ui.ts) | 16px按钮/输入圆角、无描边、模糊投影和按压内影；不是双向浮雕的Neumorphism |
| Neo Brutalist | [tokens](https://github.com/AnxForever/stylekit/blob/854eb466498bd7b96fce5730aa552df3843e0f7d/lib/styles/neo-brutalist-tokens.ts)、[spec](https://github.com/AnxForever/stylekit/blob/854eb466498bd7b96fce5730aa552df3843e0f7d/lib/design-spec/samples/neo-brutalist.ts) | [按钮](https://github.com/AnxForever/stylekit/blob/854eb466498bd7b96fce5730aa552df3843e0f7d/components/ui/brutal/button.tsx#L16)、[tabs](https://github.com/AnxForever/stylekit/blob/854eb466498bd7b96fce5730aa552df3843e0f7d/components/ui/brutal/tabs.tsx#L48)、[标签](https://github.com/AnxForever/stylekit/blob/854eb466498bd7b96fce5730aa552df3843e0f7d/components/ui/brutal/tag.tsx#L14) |

Hallmark检查整体辨识度和组件完成度；Interface Design用于控件、层级和交互状态；Impeccable用于可读性、响应式和独立复核。按用户指定的来源选择组件方向，不再用随机风格建议替代需求。

## 针对表格审查的适配

交互目标至少44px高，中文标签不跟随上游改成全大写或加宽字距。红绿仍表示旧新/增删，不拿它们当任意风格装饰色。表格正文保持可读；厚边和投影用于组件边界，不给每个数值加立体装饰。

Neo把上游4–8px硬影缩到3px，使用当前配色的高对比正文色作为结构色，以支持深色和其它配色。Soft的长动效缩至160ms，重复审阅没有整行漂浮动画；输入内影是Gridiff对工具输入面的适配。所有风格尊重减少动态效果的系统设置，禁用状态有真实disabled属性和视觉反馈。

保留原生button/select/input/details。选择器闭合态换肤，弹出的选项菜单仍由系统绘制；没有为了外观增加自造下拉菜单。焦点环立即显示，不依赖动效。样本与正式预览共享选择器规则，避免样本精致而实际工具栏仍是另一套样式。

## 最后一轮布局与细节检查

保留四种组件主题、配色与明暗的独立组合，按Hallmark、Interface Design、Impeccable的精修规则处理实际阅读和操作问题。

- 组件试样默认折叠；颜色角色和十六进制值移入配色展开区，原型评审材料不再挤占主要阅读区。
- 四个选择器统一标签、宽度和对齐，600px以下两列排列；风格说明放入试样展开区。
- 切换阅读布局或原表/清单视图时，保留当前记录并在内容区域滚到可见位置；焦点审阅切换记录时从详情顶部开始，不滚动整页。
- 错误恢复、空结果恢复和清除筛选后，键盘焦点回到搜索框。设置浮层支持Esc关闭并返回触发器，也支持点击外部关闭。

独立复核将两项视觉问题评为resolved：1280px Material/矩阵首条数据约从y=755提前到y=479；728px Soft/焦点首条记录详情约从y=1156提前到y=514。两种代表尺寸的四个选择器均整齐同排，说明不再挤占控件行。390px另查浅深和窄屏交互；真实Escape按键也已验证关闭及焦点返回。

## 验证与限制

- [check-style-interactions.js](check-style-interactions.js)的120条浏览器断言在1280px与390px通过，包括同一表格DOM、布局、筛选、记录身份保持，四套按钮/输入/页签的computed style确实不同，主按钮禁用态的文字与投影、布局/视图切换后的记录可见性、错误/空结果恢复焦点，以及设置关闭行为；运行后恢复原状态。
- 实际渲染检查1280px、728px和390px的浅深模式；四套试样使用相同配色与内容，页面无横向溢出，窄窗口的主表局部横向滚动。
- 独立审查结论为Ship：相同矩阵/配色下，四套组件及真实主表可辨；实际搜索“药”、筛选price、定位100102后切换四风格，状态保持。浏览器snapshot超时，视觉证据使用同HTML的html_preview；未独立截图捕获瞬时hover/active/focus，相关判断限源码与交互断言。
- 颜色脚本[check-theme-palettes.cjs](check-theme-palettes.cjs)继续检查330组角色配对；它不代表所有组件背景和交互状态均通过无障碍认证。
- Hallmark静态检查0 FAIL、0 REFLEX、0 WARN；其独立render阶段缺少puppeteer-core，使用T3实际渲染和浏览器检查。
- 本轮Impeccable单次静态扫描保留5条提示：3条将暗色根文字与隐式白底组合计算；1条overview父无内距但统计/展开控件自身有内距；1条使用基础18/15/14px判断层级。实际宿主、主题覆盖与渲染结果用于人工判断，不宣称扫描全绿。

交付仅是docs/design下的方案和原型。未接入正式浏览器页面或VS Code，未改比较引擎、CLI、安装包。未验证真实大表、跨页、所有系统字体、完整读屏，以及4风格×4布局×10颜色组合的逐屏效果。长文本仍用共同前后缀标记，可能包含中间未改片段。
