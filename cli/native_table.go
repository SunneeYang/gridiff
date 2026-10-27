package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// CSV values remain strings: whitespace, leading zeroes and large IDs are significant.
func parseCSVRows(text string) ([][]string, error) {
	text = strings.TrimPrefix(text, "\ufeff")
	rows := make([][]string, 0)
	row := make([]string, 0)
	var value strings.Builder
	quoted, closed, started := false, false, false
	cell := func() { row = append(row, value.String()); value.Reset(); closed = false }
	record := func() { cell(); rows = append(rows, row); row = make([]string, 0); started = false }
	for i := 0; i < len(text); i++ {
		c := text[i]
		if quoted {
			if c == '"' && i+1 < len(text) && text[i+1] == '"' {
				value.WriteByte('"')
				i++
			} else if c == '"' {
				quoted, closed = false, true
			} else {
				value.WriteByte(c)
			}
			continue
		}
		switch c {
		case ',':
			cell()
			started = true
		case '\r', '\n':
			record()
			if c == '\r' && i+1 < len(text) && text[i+1] == '\n' {
				i++
			}
		case '"':
			if value.Len() != 0 || closed {
				return nil, fmt.Errorf("CSV 第 %d 条记录的引号格式不合法。", len(rows)+1)
			}
			quoted, started = true, true
		default:
			if closed {
				return nil, fmt.Errorf("CSV 第 %d 条记录的引号格式不合法。", len(rows)+1)
			}
			value.WriteByte(c)
			started = true
		}
	}
	if quoted {
		return nil, fmt.Errorf("CSV 第 %d 条记录有未闭合的引号。", len(rows)+1)
	}
	if started || len(row) != 0 || value.Len() != 0 || closed {
		record()
	}
	return rows, nil
}

var movaFlagPattern = regexp.MustCompile(`^(all|go|ts|cs|none|i18n)(,(all|go|ts|cs|none|i18n))*$`)
var verticalFlagPattern = regexp.MustCompile(`^(all|go|ts|cs|c#|dart|tss|none|i18n)(,(all|go|ts|cs|c#|dart|tss|none|i18n))*$`)
var verticalTypePattern = regexp.MustCompile(`^(u?int(32|64)?|float(32|64)?|number|range|string|(长整数|整数|长小数|小数|文本)(数组|Map)?)$|^(Array|array|Map|map)\(.+\)$`)
var verticalTableFields = [][2]string{{"flags", "导出标记"}, {"type", "类型"}, {"name", "名称"}, {"comment", "说明"}, {"value", "值"}}

// JavaScript trim includes a BOM and excludes Go's extra control whitespace.
func tableTrim(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return r == '\ufeff' || r == '\t' || r == '\n' || r == '\v' || r == '\f' || r == '\r' || r == '\u2028' || r == '\u2029' || unicode.Is(unicode.Zs, r)
	})
}

// Match ECMAScript's default Unicode lowercasing, including the two contextual
// cases that Go's one-rune lowercase mapping does not implement.
func nativeLower(value string) string {
	if !strings.ContainsAny(value, "İΣ") {
		return strings.ToLower(value)
	}
	runes := []rune(value)
	ignorable := func(r rune) bool {
		if unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Me, r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Lm, r) || unicode.Is(unicode.Sk, r) {
			return true
		}
		switch r {
		case '\'', ':', '·', '·', '״', '‘', '’', '‧', '﹓', '﹕', '＇', '：':
			return true
		}
		return false
	}
	cased := func(r rune) bool {
		return unicode.IsUpper(r) || unicode.IsLower(r) || unicode.IsTitle(r) || unicode.Is(unicode.Properties["Other_Lowercase"], r) || unicode.Is(unicode.Properties["Other_Uppercase"], r)
	}
	var out strings.Builder
	for i, r := range runes {
		if r == 'İ' {
			out.WriteString("i\u0307")
			continue
		}
		if r == 'Σ' {
			before, after := false, false
			for j := i - 1; j >= 0; j-- {
				if !ignorable(runes[j]) {
					before = cased(runes[j])
					break
				}
			}
			for j := i + 1; j < len(runes); j++ {
				if !ignorable(runes[j]) {
					after = cased(runes[j])
					break
				}
			}
			if before && !after {
				out.WriteRune('ς')
				continue
			}
		}
		out.WriteRune(unicode.ToLower(r))
	}
	return out.String()
}

func rowValue(row []string, index int) string {
	if index < len(row) {
		return row[index]
	}
	return ""
}
func nonemptyRow(row []string) bool {
	for _, value := range row {
		if value != "" {
			return true
		}
	}
	return false
}

func nativeMova(rows [][]string) bool {
	if len(rows) < 4 || !nonemptyRow(rows[0]) {
		return false
	}
	id := false
	for _, name := range rows[2] {
		if nativeLower(name) == "id" {
			id = true
		}
	}
	if !id {
		return false
	}
	for _, flag := range rows[0] {
		if flag != "" && !movaFlagPattern.MatchString(flag) {
			return false
		}
	}
	return true
}

func nativeMovaVertical(rows [][]string) bool {
	sample := make([][]string, 0, 5)
	for _, row := range rows {
		if nonemptyRow(row) {
			sample = append(sample, row)
			if len(sample) == 5 {
				break
			}
		}
	}
	if len(sample) == 0 {
		return false
	}
	fieldRow := func(row []string) bool {
		return len(row) >= 3 && tableTrim(row[1]) != "" && tableTrim(row[2]) != "" && verticalFlagPattern.MatchString(tableTrim(row[0]))
	}
	first := sample[0]
	kind := strings.NewReplacer(" ", "", "（", "(", "）", ")").Replace(rowValue(first, 1))
	if fieldRow(first) && len(first) >= 4 && verticalTypePattern.MatchString(kind) {
		return true
	}
	count := 0
	for _, row := range sample {
		if fieldRow(row) {
			count++
		}
	}
	return count >= 2
}

func optionString(options tableOptions, name, fallback string) string {
	if value, ok := options[name].(string); ok && value != "" {
		return value
	}
	return fallback
}

func optionInteger(options tableOptions, name string, fallback int) (int, bool) {
	value, ok := options[name]
	if !ok || value == nil {
		return fallback, true
	}
	var number float64
	switch v := value.(type) {
	case int:
		return v, true
	case int64:
		number = float64(v)
	case float64:
		number = v
	case json.Number:
		var err error
		number, err = v.Float64()
		if err != nil {
			return 0, false
		}
	default:
		return 0, false
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number > float64(math.MaxInt) || number < float64(math.MinInt) {
		return 0, false
	}
	return int(number), true
}

func prepareTable(rows [][]string, metadata [][]cellMetadata, options tableOptions) (*tableData, error) {
	format := optionString(options, "format", "auto")
	if format == "auto" {
		if nativeMova(rows) {
			format = "mova"
		} else if nativeMovaVertical(rows) {
			format = "mova-vertical"
		} else {
			format = "csv"
		}
	}
	switch format {
	case "csv", "mova", "mova-vertical", "custom", "headerless":
	default:
		return nil, errors.New("未知表格格式。")
	}
	table := &tableData{Format: format, Fields: make([]tableField, 0), Rows: make([]tableRow, 0)}
	if len(rows) == 0 {
		return table, nil
	}
	vertical := format == "mova-vertical"
	headerless := vertical || format == "headerless"
	header, start, description := 1, 2, 0
	valid := true
	if format == "mova" {
		header, start, description = 3, 5, 4
	} else if format == "custom" {
		var h, s, d bool
		header, h = optionInteger(options, "headerRow", 0)
		start, s = optionInteger(options, "dataStartRow", 0)
		description, d = optionInteger(options, "descriptionRow", 0)
		valid = h && s && d
	} else if headerless {
		start = 1
	}
	if !headerless && (!valid || header < 1 || start <= header || description < 0 || description >= start || description != 0 && description == header) {
		return nil, errors.New("表头配置不合法：字段名、说明必须在数据起始记录之前，且不能是同一行。")
	}
	if !headerless && (header > len(rows) || description > len(rows)) {
		return nil, errors.New("文件不足以包含指定的表头。")
	}
	var names []string
	if headerless {
		width := 0
		if vertical {
			width = 5
		}
		for _, row := range rows {
			width = max(width, len(row))
		}
		names = make([]string, width)
		for i := range names {
			if vertical && i < len(verticalTableFields) {
				names[i] = verticalTableFields[i][0]
			} else {
				names[i] = fmt.Sprintf("列%d", i+1)
			}
		}
	} else {
		names = rows[header-1]
	}
	seen := make(map[string]bool, len(names))
	for i, name := range names {
		if tableTrim(name) == "" {
			return nil, fmt.Errorf("第 %d 列没有字段名，请选择正确的表头格式。", i+1)
		}
		if seen[name] {
			return nil, fmt.Errorf("字段名「%s」重复，无法按字段对齐。", name)
		}
		seen[name] = true
		field := tableField{Name: name, Label: name, Index: i}
		if vertical && i < len(verticalTableFields) {
			field.Label = verticalTableFields[i][1]
		} else if description != 0 {
			if label := rowValue(rows[description-1], i); label != "" {
				field.Label = label
			}
		}
		if format == "mova" {
			field.Type, field.Flags = rowValue(rows[1], i), rowValue(rows[0], i)
		}
		table.Fields = append(table.Fields, field)
	}
	for i, row := range rows {
		if format == "mova" && i >= start-1 {
			continue
		}
		if len(row) > len(names) && nonemptyRow(row[len(names):]) {
			return nil, fmt.Errorf("第 %d 条记录有 %d 列，超出表头的 %d 列；请检查格式或源文件。", i+1, len(row), len(names))
		}
	}
	for i := start - 1; i < len(rows); i++ {
		row := rows[i]
		if !nonemptyRow(row[:min(len(row), len(names))]) {
			table.SkippedBlankRows++
			continue
		}
		prepared := tableRow{Record: i + 1, Values: make([]string, len(names))}
		copy(prepared.Values, row)
		if metadata != nil {
			prepared.Metadata = make([]cellMetadata, len(names))
			for j := range names {
				prepared.Metadata[j] = cellMetadata{Type: "empty", Raw: nil}
				if i < len(metadata) && j < len(metadata[i]) && metadata[i][j].Type != "" {
					prepared.Metadata[j] = metadata[i][j]
				}
			}
		}
		table.Rows = append(table.Rows, prepared)
	}
	return table, nil
}

// JSON.stringify is part of the row identity contract. In particular HTML and
// U+2028/U+2029 are literal characters, and negative zero has the identity of zero.
func nativeJSONString(value string) string {
	var out strings.Builder
	out.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"', '\\':
			out.WriteByte('\\')
			out.WriteRune(r)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&out, `\u%04x`, r)
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
	return out.String()
}

func nativeJSON(value any) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case string:
		return nativeJSONString(v)
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		if v == 0 {
			return "0"
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return "null"
		}
	case []any:
		var b strings.Builder
		b.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(nativeJSON(item))
		}
		b.WriteByte(']')
		return b.String()
	case []string:
		var b strings.Builder
		b.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(nativeJSONString(item))
		}
		b.WriteByte(']')
		return b.String()
	}
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func nativeString(value any) string {
	if value == nil {
		return "null"
	}
	if v, ok := value.(string); ok {
		return v
	}
	return nativeJSON(value)
}

func nativeRawEqual(a, b any) bool {
	switch value := a.(type) {
	case nil:
		return b == nil
	case string:
		other, ok := b.(string)
		return ok && value == other
	case bool:
		other, ok := b.(bool)
		return ok && value == other
	case float64:
		if other, ok := b.(float64); ok {
			return value == other
		}
	}
	return nativeJSON(a) == nativeJSON(b)
}

func nativeIdentity(row *tableRow, index int, includeFormula bool) any {
	if index < len(row.Metadata) {
		meta := row.Metadata[index]
		if includeFormula {
			return []any{meta.Type, meta.Raw, nil}
		}
		return []any{meta.Type, meta.Raw}
	}
	return rowValue(row.Values, index)
}

type indexedNativeRow struct {
	row     *tableRow
	parts   []string
	unkeyed bool
}

func compareNativeTables(before, after *tableData, options tableOptions) (*diffModel, error) {
	// Bound the combined rectangular result before allocating its rows/cells.
	widths := make(map[string]bool)
	for _, field := range before.Fields {
		widths[field.Name] = true
	}
	for _, field := range after.Fields {
		widths[field.Name] = true
	}
	if len(widths) != 0 && (len(before.Rows) > maxCells/len(widths) || len(after.Rows) > maxCells/len(widths)-len(before.Rows)) {
		return nil, errors.New("比较范围超过 100 万单元格，请缩小表格或使用文本对比。")
	}
	oldFields, newFields := make(map[string]*tableField), make(map[string]*tableField)
	for i, f := range before.Fields {
		f.Index = i
		oldFields[f.Name] = &f
	}
	for i, f := range after.Fields {
		f.Index = i
		newFields[f.Name] = &f
	}
	names := make([]string, 0, len(widths))
	for _, f := range after.Fields {
		names = append(names, f.Name)
	}
	for _, f := range before.Fields {
		if newFields[f.Name] == nil {
			names = append(names, f.Name)
		}
	}
	model := &diffModel{Fields: make([]diffField, 0, len(names)), Rows: make([]diffRow, 0), Schema: make([]schemaChange, 0), Keys: make([]string, 0), Alignment: "key", Formats: []string{before.Format, after.Format}, Unkeyed: map[string]int{"before": 0, "after": 0}}
	for _, name := range names {
		model.Fields = append(model.Fields, diffField{Name: name, Before: oldFields[name], After: newFields[name]})
	}
	keys := make([]string, 0)
	switch value := options["keyColumns"].(type) {
	case []string:
		keys = append(keys, value...)
	case []any:
		for _, key := range value {
			if text, ok := key.(string); ok {
				keys = append(keys, text)
			} else {
				return nil, errors.New("主键字段必须为字符串。")
			}
		}
	}
	position := optionString(options, "alignment", "key") == "position"
	if !position && len(keys) == 0 && len(names) != 0 {
		table := after
		if len(table.Fields) == 0 {
			table = before
		}
		key := table.Fields[0].Name
		if table.Format == "mova-vertical" {
			key = "name"
		} else {
			for _, field := range table.Fields {
				if nativeLower(field.Name) == "id" {
					key = field.Name
					break
				}
			}
		}
		keys = append(keys, key)
	}
	seen := make(map[string]bool)
	for _, key := range keys {
		if seen[key] {
			return nil, errors.New("主键字段不能重复。")
		}
		seen[key] = true
	}
	index := func(table *tableData, fields map[string]*tableField, side string) (map[string]indexedNativeRow, []string, error) {
		if !position && len(table.Fields) != 0 {
			for _, key := range keys {
				if fields[key] == nil {
					return nil, nil, fmt.Errorf("%s缺少主键字段「%s」，请选择两侧共有的主键或按行号对齐。", side, key)
				}
			}
		}
		result := make(map[string]indexedNativeRow, len(table.Rows))
		order := make([]string, 0, len(table.Rows))
		occurrences := make(map[string]int)
		for i := range table.Rows {
			row := &table.Rows[i]
			parts := make([]string, 0, max(1, len(keys)))
			if position {
				parts = append(parts, strconv.Itoa(i+1))
			} else {
				for _, key := range keys {
					parts = append(parts, rowValue(row.Values, fields[key].Index))
				}
			}
			unkeyed := !position && len(keys) == 1 && parts[0] == "" && ((table.Format == "mova" && nativeLower(keys[0]) == "id" && fields[keys[0]].Index == 0) || (table.Format == "mova-vertical" && keys[0] == "name"))
			if !position && !unkeyed {
				for _, key := range keys {
					j := fields[key].Index
					missing := tableTrim(rowValue(row.Values, j)) == ""
					if j < len(row.Metadata) {
						raw := row.Metadata[j].Raw
						missing = raw == nil || tableTrim(nativeString(raw)) == ""
					}
					if missing {
						return nil, nil, fmt.Errorf("%s第 %d 条记录缺少主键值，请选择其他主键或按行号对齐。", side, row.Record)
					}
				}
			}
			var key string
			if position {
				key = nativeJSON(parts)
			} else {
				values := make([]any, 0, len(keys))
				for _, name := range keys {
					values = append(values, nativeIdentity(row, fields[name].Index, false))
				}
				key = nativeJSON(values)
			}
			if unkeyed {
				values := make([]any, len(names))
				for j, name := range names {
					if field := fields[name]; field != nil {
						values[j] = nativeIdentity(row, field.Index, true)
					}
				}
				fingerprint := nativeJSON(values)
				occurrences[fingerprint]++
				key = `{"values":` + fingerprint + `,"occurrence":` + strconv.Itoa(occurrences[fingerprint]) + `}`
			}
			if previous, ok := result[key]; ok {
				return nil, nil, fmt.Errorf("%s主键 %s 重复（第 %d、%d 条记录），请使用复合主键或按行号对齐。", side, strings.Join(parts, " / "), previous.row.Record, row.Record)
			}
			result[key] = indexedNativeRow{row: row, parts: parts, unkeyed: unkeyed}
			order = append(order, key)
		}
		return result, order, nil
	}
	oldRows, oldOrder, err := index(before, oldFields, "旧版本")
	if err != nil {
		return nil, err
	}
	newRows, newOrder, err := index(after, newFields, "新版本")
	if err != nil {
		return nil, err
	}
	commonOrder := make(map[string]int)
	commonCount := 0
	for _, key := range oldOrder {
		if _, ok := newRows[key]; ok && !oldRows[key].unkeyed {
			commonOrder[key] = commonCount
			commonCount++
		}
	}
	moved := make(map[string]bool)
	commonCount = 0
	for _, key := range newOrder {
		if _, ok := oldRows[key]; ok && !newRows[key].unkeyed {
			if commonOrder[key] != commonCount {
				moved[key] = true
			}
			commonCount++
		}
	}
	for _, field := range model.Fields {
		if field.Before == nil || field.After == nil {
			kind := "added"
			if field.Before != nil {
				kind = "removed"
			}
			// Interfaces containing typed nil pointers still encode as null.
			model.Schema = append(model.Schema, schemaChange{Name: field.Name, Kind: kind, Before: field.Before, After: field.After})
			continue
		}
		for _, property := range []struct{ name, old, next string }{{"label", field.Before.Label, field.After.Label}, {"type", field.Before.Type, field.After.Type}, {"flags", field.Before.Flags, field.After.Flags}} {
			if property.old != property.next {
				model.Schema = append(model.Schema, schemaChange{Name: field.Name, Kind: property.name, Before: property.old, After: property.next})
			}
		}
	}
	oldCommon, newCommon := make([]string, 0), make([]string, 0)
	for _, field := range before.Fields {
		if newFields[field.Name] != nil {
			oldCommon = append(oldCommon, field.Name)
		}
	}
	for _, field := range after.Fields {
		if oldFields[field.Name] != nil {
			newCommon = append(newCommon, field.Name)
		}
	}
	if nativeJSON(oldCommon) != nativeJSON(newCommon) {
		model.Schema = append(model.Schema, schemaChange{Name: "字段顺序", Kind: "order", Before: oldCommon, After: newCommon})
	}
	model.Counts.Moved, model.Counts.Schema = len(moved), len(model.Schema)
	removedBefore := make(map[string][]string)
	pending := make([]string, 0)
	lastCommon := ""
	hasCommon := false
	for _, key := range oldOrder {
		if _, ok := newRows[key]; ok {
			if len(pending) != 0 {
				removedBefore[key] = pending
			}
			pending = nil
			lastCommon, hasCommon = key, true
		} else {
			pending = append(pending, key)
		}
	}
	rowKeys := make([]string, 0, len(oldRows)+len(newRows))
	if !hasCommon {
		rowKeys = append(rowKeys, pending...)
	}
	for _, key := range newOrder {
		rowKeys = append(rowKeys, removedBefore[key]...)
		rowKeys = append(rowKeys, key)
		if hasCommon && key == lastCommon {
			rowKeys = append(rowKeys, pending...)
		}
	}
	model.Rows = make([]diffRow, 0, len(rowKeys))
	for _, key := range rowKeys {
		old, oldExists := oldRows[key]
		next, newExists := newRows[key]
		row := diffRow{Key: key, Status: "unchanged", Moved: moved[key], Cells: make([]diffCell, len(model.Fields))}
		changes := 0
		for i, field := range model.Fields {
			cell := &row.Cells[i]
			if oldExists && field.Before != nil {
				cell.Before = &old.row.Values[field.Before.Index]
				if field.Before.Index < len(old.row.Metadata) {
					cell.BeforeMeta = &old.row.Metadata[field.Before.Index]
				}
			}
			if newExists && field.After != nil {
				cell.After = &next.row.Values[field.After.Index]
				if field.After.Index < len(next.row.Metadata) {
					cell.AfterMeta = &next.row.Metadata[field.After.Index]
				}
			}
			// Compare normalized scalar metadata directly instead of creating two
			// arrays and two JSON strings for every cell in the workbook.
			switch {
			case cell.Before == nil || cell.After == nil:
				cell.Changed = (cell.Before == nil) != (cell.After == nil)
			case cell.BeforeMeta != nil || cell.AfterMeta != nil:
				cell.Changed = cell.BeforeMeta == nil || cell.AfterMeta == nil || cell.BeforeMeta.Type != cell.AfterMeta.Type || !nativeRawEqual(cell.BeforeMeta.Raw, cell.AfterMeta.Raw)
			default:
				cell.Changed = *cell.Before != *cell.After
			}
			if oldExists && newExists && field.Before != nil && field.After != nil && cell.Changed {
				changes++
			}
		}
		identity := old
		if newExists {
			identity = next
		}
		row.Unkeyed, row.Identity = identity.unkeyed, strings.Join(identity.parts, " / ")
		if oldExists {
			row.BeforeRecord = &old.row.Record
		}
		if newExists {
			row.AfterRecord = &next.row.Record
		}
		if row.Unkeyed {
			a, b := "—", "—"
			if oldExists {
				a = strconv.Itoa(old.row.Record)
			}
			if newExists {
				b = strconv.Itoa(next.row.Record)
			}
			row.Identity = "无主键记录 " + a + " → " + b
		}
		switch {
		case !oldExists:
			row.Status = "added"
			model.Counts.Added++
		case !newExists:
			row.Status = "removed"
			model.Counts.Removed++
		case changes != 0:
			row.Status = "modified"
			model.Counts.Modified++
		default:
			model.Counts.Unchanged++
		}
		model.Counts.Cells += changes
		model.Rows = append(model.Rows, row)
	}
	if position {
		model.Alignment = "position"
	} else {
		model.Keys = keys
	}
	for _, row := range oldRows {
		if row.unkeyed {
			model.Unkeyed["before"]++
		}
	}
	for _, row := range newRows {
		if row.unkeyed {
			model.Unkeyed["after"]++
		}
	}
	return model, nil
}

func selectNativeView(model *diffModel, state viewState) ([]diffRow, pageInfo) {
	changed := make([]bool, len(model.Fields))
	anyChanged := false
	for _, row := range model.Rows {
		if row.Status == "removed" {
			continue
		}
		for i, cell := range row.Cells {
			include := cell.Changed
			if row.Status == "added" {
				include = cell.After != nil && *cell.After != ""
			}
			if include {
				changed[i], anyChanged = true, true
			}
		}
	}
	if model.Counts.Removed > 0 && model.Counts.Added == 0 && !anyChanged {
		for _, row := range model.Rows {
			if row.Status == "removed" {
				for i, cell := range row.Cells {
					if cell.Before != nil && *cell.Before != "" {
						changed[i] = true
					}
				}
			}
		}
	}
	fields := make([]int, 0, len(model.Fields))
	for i := range model.Fields {
		if !state.OnlyFields || changed[i] {
			fields = append(fields, i)
		}
	}
	query := nativeLower(state.Query)
	filtered := make([]int, 0, len(model.Rows))
	for i, row := range model.Rows {
		if state.OnlyChanges && row.Status == "unchanged" && !row.Moved {
			schemaChanged := false
			for j, cell := range row.Cells {
				if cell.Changed && (model.Fields[j].Before == nil || model.Fields[j].After == nil) {
					schemaChanged = true
					break
				}
			}
			if !schemaChanged {
				continue
			}
		}
		matches := query == "" || strings.Contains(nativeLower(row.Identity), query)
		if !matches {
			for _, cell := range row.Cells {
				for _, value := range []*string{cell.Before, cell.After} {
					if value != nil && strings.Contains(nativeLower(*value), query) {
						matches = true
						break
					}
				}
				if matches {
					break
				}
				for _, meta := range []*cellMetadata{cell.BeforeMeta, cell.AfterMeta} {
					if meta != nil && meta.Raw != nil && strings.Contains(nativeLower(nativeString(meta.Raw)), query) {
						matches = true
						break
					}
				}
				if matches {
					break
				}
			}
		}
		if matches {
			filtered = append(filtered, i)
		}
	}
	pageSize := max(1, min(100, 3000/max(1, len(fields))))
	pages := max(1, (len(filtered)+pageSize-1)/pageSize)
	page := max(0, min(state.Page, pages-1))
	info := pageInfo{Page: page, Pages: pages, PageSize: pageSize, FieldIndexes: fields, TotalRows: len(model.Rows), FilteredRows: len(filtered)}
	rows := make([]diffRow, 0, min(pageSize, len(filtered)))
	for _, i := range filtered[min(page*pageSize, len(filtered)):min((page+1)*pageSize, len(filtered))] {
		rows = append(rows, model.Rows[i])
	}
	return rows, info
}
