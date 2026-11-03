# JSON 报告约定

当前报告 `schemaVersion` 为 `1`。不同版本先核对包内 CLI 的帮助和随包说明。

- `version` 是 CLI 构建版本；`sources` 固定为旧、新输入路径。
- `complete` 表示所选范围是否全部成功比较。失败时顶层 `error` 给出原因，进程返回非零；`sheets` 可能仍保留成功表的结果。完整成功时才提供顶层 `counts`。
- `sheetSelection` 记录首表、全部表或指定表的选择；XLSX 的 `sourceSheets` 分别列出两侧实际读取的表名。首表按位置配对，改名不算整表新增或删除；其他范围按名称配对。
- `options` 是本次请求的比较设置。每个 `sheets` 项包含 `name`、`status`、双侧 `skippedBlankRows`、错误或 `result`。
- `result.keys`、`alignment`、`formats` 是实际使用的主键、对齐方式及双侧表头格式。
- `result.fields` 是字段列表，`result.rows[*].cells` 按相同索引对应字段。每个单元格保留 `before`、`after`、`changed`，XLSX 还保留类型及原始值元数据。`null` 表示这一侧不存在，空字符串仍是一个值；文本 ID、空格和前导零保留原样。
- 每条记录有 `identity`、旧新记录编号、`status` 和 `moved`。`rows` 包含全部记录，未变化的记录仍在；按 `status`、`moved` 和单元格 `changed` 找差异。
- `result.schema` 包含字段结构变化；结构变化也可能使单元格变化，而记录仍显示 `unchanged`，因此要一并读取。字段元数据在 `fields` 的双侧定义中。
- `counts` 的 `added`、`removed`、`modified`、`unchanged` 统计记录，`moved` 统计顺序变化，`schema` 统计结构变化。`cells` 仅统计共有记录、共有字段中的值修改，不包含整条记录或字段的新增删除。

## 结论边界

完整只针对实际选中的工作表与现有比较语义：XLSX 比较保存的值和类型，公式仅使用缓存结果（无缓存按空值），不比较表达式或重新计算。字体、颜色、图表等排版不在范围内。

自动格式识别和自动主键按现有规则执行，无法识别的格式可显式指定。Mova 四行表头只比较表头声明的字段；尾部额外列不参与。全空记录会跳过并计数；Mova 无主键记录按完整内容和重复次数匹配，不能将其当作稳定业务 ID。
