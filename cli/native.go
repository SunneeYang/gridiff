package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

type nativeComparison struct {
	mu       sync.Mutex
	csv      [2][][]string
	books    [2][]rawSheet
	cache    map[string]*nativeSheet
	revision uint64
}

type nativeSheet struct {
	name, status, signature, failure string
	options                          tableOptions
	tables                           [2]*tableData
	result                           *diffModel
	cells                            int
}

type nativeSettings struct {
	Generation   uint64       `json:"generation,omitempty"`
	Swapped      bool         `json:"swapped"`
	Options      tableOptions `json:"options"`
	SheetName    string       `json:"sheetName,omitempty"`
	SheetOptions [][2]any     `json:"sheetOptions"`
}

type nativeSheetInfo struct {
	Name   string      `json:"name"`
	Status string      `json:"status"`
	Counts *diffCounts `json:"counts,omitempty"`
	Error  string      `json:"error"`
}

type nativePayload struct {
	ColumnCount      int                 `json:"columnCount"`
	Type             string              `json:"type"`
	Result           *diffModel          `json:"result"`
	Error            string              `json:"error"`
	Revision         uint64              `json:"revision"`
	Options          tableOptions        `json:"options"`
	XLSX             bool                `json:"xlsx"`
	Sheets           []nativeSheetInfo   `json:"sheets"`
	SheetName        string              `json:"sheetName,omitempty"`
	SheetSelection   sheetSelection      `json:"sheetSelection"`
	Skipped          []int               `json:"skipped"`
	KeyFields        []map[string]string `json:"keyFields"`
	Busy             bool                `json:"busy"`
	ReadonlySnapshot bool                `json:"readonlySnapshot"`
	Sources          []string            `json:"sources"`
	Title            string              `json:"title"`
	Unsupported      bool                `json:"unsupported"`
	Generation       uint64              `json:"generation"`
	Presentation     uint64              `json:"presentation"`
	ViewState        viewState           `json:"viewState"`
	PageInfo         *pageInfo           `json:"pageInfo,omitempty"`
	Settings         nativeSettings      `json:"settings"`
}

func defaultTableOptions() tableOptions {
	return tableOptions{"format": "auto", "keyColumns": []string{}}
}

func normalizeOptions(raw json.RawMessage) (tableOptions, error) {
	var values map[string]json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil || values == nil {
		return nil, errors.New("比较设置无效。")
	}
	result := tableOptions{}
	for key, value := range values {
		switch key {
		case "format", "alignment":
			var text string
			if json.Unmarshal(value, &text) != nil {
				return nil, errors.New("比较设置无效。")
			}
			valid := false
			choices := []string{"auto", "csv", "mova", "mova-vertical", "headerless", "custom"}
			if key == "alignment" {
				choices = []string{"key", "position"}
			}
			for _, choice := range choices {
				if text == choice {
					valid = true
				}
			}
			if !valid {
				return nil, errors.New("表头格式或对齐方式无效。")
			}
			result[key] = text
		case "keyColumns":
			var keys []string
			if string(value) == "null" || json.Unmarshal(value, &keys) != nil || len(keys) > 256 {
				return nil, errors.New("主键设置无效。")
			}
			for _, key := range keys {
				if len(key) == 0 || len(key) > 4096 {
					return nil, errors.New("主键设置无效。")
				}
			}
			result[key] = keys
		case "headerRow", "dataStartRow", "descriptionRow":
			var number int
			minimum := 1
			if key == "descriptionRow" {
				minimum = 0
			}
			if json.Unmarshal(value, &number) != nil || number < minimum || number > maxCells {
				return nil, errors.New("表头记录编号无效。")
			}
			result[key] = number
		default:
			return nil, errors.New("比较设置包含未知字段。")
		}
	}
	return result, nil
}

func mergeOptions(base, patch tableOptions) tableOptions {
	result := defaultTableOptions()
	for key, value := range base {
		result[key] = value
	}
	for key, value := range patch {
		result[key] = value
	}
	return result
}

func readNativeSettings(raw json.RawMessage, generation uint64) (nativeSettings, error) {
	result := nativeSettings{Options: defaultTableOptions(), SheetOptions: [][2]any{}}
	if len(raw) == 0 || string(raw) == "null" {
		return result, nil
	}
	var values map[string]json.RawMessage
	if json.Unmarshal(raw, &values) != nil || values == nil {
		return result, errors.New("比较设置无效。")
	}
	if value := values["generation"]; len(value) > 0 {
		if json.Unmarshal(value, &result.Generation) != nil {
			return result, errors.New("比较代次无效。")
		}
		if result.Generation != generation {
			return nativeSettings{Options: defaultTableOptions(), SheetOptions: [][2]any{}}, nil
		}
	}
	if value := values["swapped"]; len(value) > 0 && json.Unmarshal(value, &result.Swapped) != nil {
		return result, errors.New("交换设置无效。")
	}
	if value := values["sheetName"]; len(value) > 0 && json.Unmarshal(value, &result.SheetName) != nil {
		return result, errors.New("工作表设置无效。")
	}
	if value := values["options"]; len(value) > 0 {
		options, err := normalizeOptions(value)
		if err != nil {
			return result, err
		}
		result.Options = mergeOptions(nil, options)
	}
	if value := values["sheetOptions"]; len(value) > 0 {
		var entries [][]json.RawMessage
		if json.Unmarshal(value, &entries) != nil || len(entries) > 10000 {
			return result, errors.New("工作表设置无效。")
		}
		for _, entry := range entries {
			var name string
			if len(entry) != 2 || json.Unmarshal(entry[0], &name) != nil {
				return result, errors.New("工作表设置无效。")
			}
			options, err := normalizeOptions(entry[1])
			if err != nil {
				return result, err
			}
			result.SheetOptions = append(result.SheetOptions, [2]any{name, mergeOptions(nil, options)})
		}
	}
	if len(values["options"]) == 0 && result.SheetName != "" {
		for _, entry := range result.SheetOptions {
			if entry[0] == result.SheetName {
				result.Options = entry[1].(tableOptions)
				break
			}
		}
	}

	return result, nil
}

func readNativeView(raw json.RawMessage) (viewState, error) {
	result := viewState{View: "grid", OnlyChanges: true, OnlyFields: true}
	if len(raw) == 0 {
		return result, nil
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return result, errors.New("视图设置无效。")
	}
	for key, value := range object {
		var err error
		switch key {
		case "view":
			err = json.Unmarshal(value, &result.View)
			if result.View != "grid" && result.View != "list" {
				err = errors.New("invalid")
			}
		case "onlyChanges":
			err = json.Unmarshal(value, &result.OnlyChanges)
		case "onlyFields":
			err = json.Unmarshal(value, &result.OnlyFields)
		case "query":
			err = json.Unmarshal(value, &result.Query)
		case "page":
			err = json.Unmarshal(value, &result.Page)
			if result.Page < 0 {
				err = errors.New("invalid")
			}
		default:
			err = errors.New("unknown")
		}
		if string(value) == "null" || err != nil {
			return result, errors.New("视图设置无效。")
		}
	}
	return result, nil
}

func (n *nativeComparison) prepare(data *snapshot, settings *nativeSettings) ([]*nativeSheet, error) {
	options := map[string]tableOptions{}
	for _, entry := range settings.SheetOptions {
		options[entry[0].(string)] = entry[1].(tableOptions)
	}
	if settings.SheetName != "" {
		options[settings.SheetName] = settings.Options
	}
	oldSide, newSide := 0, 1
	if settings.Swapped {
		oldSide, newSide = 1, 0
	}
	oldSheets, newSheets := map[string]rawSheet{}, map[string]rawSheet{}
	names := []string{}
	if !data.XLSX {
		names = []string{""}
	} else {
		pairName := ""
		if len(n.books[newSide]) > 0 {
			pairName = n.books[newSide][0].Name
		} else if len(n.books[oldSide]) > 0 {
			pairName = n.books[oldSide][0].Name
		}
		if data.SheetSelection.Mode == "first" && settings.SheetName != "" && pairName != "" && settings.SheetName != pairName {
			options[pairName] = settings.Options
			settings.SheetName = pairName
		}
		for _, sheet := range n.books[newSide] {
			names = append(names, sheet.Name)
			newSheets[sheet.Name] = sheet
		}
		for _, sheet := range n.books[oldSide] {
			name := sheet.Name
			if data.SheetSelection.Mode == "first" && pairName != "" {
				name = pairName
			}
			oldSheets[name] = sheet
			if _, exists := newSheets[name]; !exists {
				names = append(names, name)
			}
		}
	}
	prepared := make([]*nativeSheet, 0, len(names))
	budget := 0
	for _, name := range names {
		config := options[name]
		if data.XLSX && settings.SheetName == "" {
			config = mergeOptions(settings.Options, config)
		}
		if !data.XLSX {
			config = settings.Options
		}
		config = mergeOptions(nil, config)
		signature, _ := json.Marshal(config)
		key := fmt.Sprintf("%t:%s", settings.Swapped, name)
		cached := n.cache[key]
		fresh := cached == nil || cached.signature != string(signature)
		if fresh {
			cached = &nativeSheet{name: name, options: config, signature: string(signature), status: "common"}
			if data.XLSX {
				_, old := oldSheets[name]
				_, next := newSheets[name]
				if !old {
					cached.status = "added"
				} else if !next {
					cached.status = "removed"
				}
			}
			for i, side := range []int{oldSide, newSide} {
				var rows [][]string
				var metadata [][]cellMetadata
				if data.XLSX {
					sheet := oldSheets[name]
					if i == 1 {
						sheet = newSheets[name]
					}
					rows, metadata = sheet.Values, sheet.Metadata
				} else {
					rows = n.csv[side]
				}
				table, err := prepareTable(rows, metadata, config)
				if err != nil {
					cached.failure = err.Error()
					break
				}
				cached.tables[i] = table
			}
			if cached.failure == "" {
				fields := map[string]bool{}
				for _, table := range cached.tables {
					for _, field := range table.Fields {
						fields[field.Name] = true
					}
				}
				cached.cells = (len(cached.tables[0].Rows) + len(cached.tables[1].Rows)) * len(fields)
			}
		}
		budget += cached.cells
		if budget > maxCells {
			return nil, errors.New("比较范围超过 100 万单元格，请缩小工作簿。")
		}
		if fresh {
			if cached.failure == "" {
				result, err := compareNativeTables(cached.tables[0], cached.tables[1], config)
				cached.result = result
				if err != nil {
					cached.failure = err.Error()
				}
			}
			n.cache[key] = cached
		}
		prepared = append(prepared, cached)
	}
	if len(prepared) == 0 {
		return nil, errors.New("工作簿中没有工作表。")
	}
	return prepared, nil
}

func projectNativeResult(model *diffModel, view viewState) (*diffModel, pageInfo) {
	rows, info := selectNativeView(model, view)
	result := *model
	result.Fields = make([]diffField, 0, len(info.FieldIndexes))
	result.Rows = make([]diffRow, 0, len(rows))
	for _, index := range info.FieldIndexes {
		result.Fields = append(result.Fields, model.Fields[index])
	}
	nameIndex := -1
	vertical := false
	for _, format := range model.Formats {
		if format == "mova-vertical" {
			vertical = true
		}
	}
	for i, field := range model.Fields {
		if vertical && field.Name == "comment" || !vertical && (strings.EqualFold(field.Name, "name") || field.Name == "名称" || field.Name == "名字") {
			nameIndex = i
			break
		}
	}
	for _, row := range rows {
		projected := row
		projected.Key = ""
		projected.Cells = make([]diffCell, 0, len(info.FieldIndexes))
		for _, index := range info.FieldIndexes {
			projected.Cells = append(projected.Cells, row.Cells[index])
		}
		if nameIndex >= 0 {
			cell := row.Cells[nameIndex]
			if cell.After != nil {
				projected.DisplayName = *cell.After
			}
			if projected.DisplayName == "" && cell.Before != nil {
				projected.DisplayName = *cell.Before
			}
		}
		for i, cell := range row.Cells {
			if cell.Changed && (model.Fields[i].Before == nil || model.Fields[i].After == nil) {
				projected.SchemaChanged = true
				break
			}
		}
		result.Rows = append(result.Rows, projected)
	}
	info.FieldIndexes = make([]int, len(result.Fields))
	for i := range info.FieldIndexes {
		info.FieldIndexes[i] = i
	}
	return &result, info
}

func (n *nativeComparison) payload(data *snapshot, id uint64, action, name string, patch tableOptions, settings nativeSettings, view viewState) (nativePayload, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.revision++
	if action == "options" {
		settings.Options = mergeOptions(settings.Options, patch)
	}
	if action == "sheet" {
		if settings.SheetName != "" {
			found := false
			for i, entry := range settings.SheetOptions {
				if entry[0] == settings.SheetName {
					settings.SheetOptions[i][1] = settings.Options
					found = true
					break
				}
			}
			if !found {
				settings.SheetOptions = append(settings.SheetOptions, [2]any{settings.SheetName, settings.Options})
			}
		}
		settings.SheetName = name
		settings.Options = defaultTableOptions()
		for _, entry := range settings.SheetOptions {
			if entry[0] == name {
				settings.Options = entry[1].(tableOptions)
			}
		}
	}
	if action == "swap" {
		settings.Swapped = !settings.Swapped
	}
	if action != "view" && action != "load" {
		view.Page = 0
	}
	if action == "refresh" {
		delete(n.cache, fmt.Sprintf("%t:%s", settings.Swapped, settings.SheetName))
	}
	sources := append([]string{}, data.Sources...)
	if settings.Swapped {
		sources[0], sources[1] = sources[1], sources[0]
	}
	title := data.Title
	if settings.Swapped {
		parts := strings.FieldsFunc(sources[1], func(r rune) bool { return r == '/' || r == '\\' })
		if len(parts) > 0 {
			title = parts[len(parts)-1]
		}
	}
	payload := nativePayload{Type: "comparison", Error: data.Error, Revision: n.revision, Options: settings.Options, XLSX: data.XLSX, Sheets: []nativeSheetInfo{}, SheetSelection: data.SheetSelection,
		Skipped: []int{}, KeyFields: []map[string]string{}, ReadonlySnapshot: true, Sources: sources, Title: title, Unsupported: data.Unsupported, Generation: data.Generation, Presentation: id, ViewState: view, Settings: settings}
	if data.Error != "" {
		return payload, nil
	}
	prepared, err := n.prepare(data, &settings)
	if err != nil {
		payload.Error = err.Error()
		return payload, nil
	}
	var current *nativeSheet
	for _, sheet := range prepared {
		if sheet.name == settings.SheetName {
			current = sheet
			break
		}
	}
	if action == "sheet" && current == nil {
		return payload, errors.New("工作表不存在。")
	}
	if current == nil {
		for _, sheet := range prepared {
			changed := sheet.failure != "" || sheet.status != "common" || sheet.result != nil && (sheet.result.Counts.Added > 0 || sheet.result.Counts.Removed > 0 || sheet.result.Counts.Modified > 0 || sheet.result.Counts.Moved > 0 || sheet.result.Counts.Schema > 0)
			if changed {
				current = sheet
				break
			}
		}
		if current == nil {
			current = prepared[0]
		}
	}
	settings.Options = current.options
	settings.SheetName = current.name
	if data.XLSX {
		settings.SheetOptions = [][2]any{}
		defaults, _ := json.Marshal(defaultTableOptions())
		for _, sheet := range prepared {
			info := nativeSheetInfo{Name: sheet.name, Status: sheet.status, Error: sheet.failure}
			if sheet.result != nil {
				counts := sheet.result.Counts
				info.Counts = &counts
			}
			payload.Sheets = append(payload.Sheets, info)
			if sheet.signature != string(defaults) || sheet.name == current.name {
				settings.SheetOptions = append(settings.SheetOptions, [2]any{sheet.name, sheet.options})
			}
		}
	}
	payload.Options = current.options
	payload.SheetName = current.name
	payload.Error = current.failure
	if current.tables[0] != nil && current.tables[1] != nil {
		nonempty := []*tableData{}
		for _, table := range current.tables {
			payload.Skipped = append(payload.Skipped, table.SkippedBlankRows)
			if len(table.Fields) > 0 {
				nonempty = append(nonempty, table)
			}
		}
		if len(nonempty) > 0 {
			for _, field := range nonempty[0].Fields {
				common := true
				for _, table := range nonempty[1:] {
					found := false
					for _, other := range table.Fields {
						if other.Name == field.Name {
							found = true
							break
						}
					}
					common = common && found
				}
				if common {
					payload.KeyFields = append(payload.KeyFields, map[string]string{"name": field.Name, "label": field.Label})
				}
			}
		}
	}
	if current.result != nil && current.failure == "" {
		payload.ColumnCount = len(current.result.Fields)
		result, info := projectNativeResult(current.result, view)
		payload.Result = result
		payload.PageInfo = &info
		payload.ViewState.Page = info.Page
	}
	payload.Settings = settings
	return payload, nil
}

func (s *comparisonServer) compare(w http.ResponseWriter, r *http.Request, data *snapshot) {
	object, err := readObject(w, r, maxBytes)
	if err != nil {
		failHTTP(w, 400, err.Error())
		return
	}
	allowed := map[string]bool{"action": true, "id": true, "generation": true, "view": true, "settings": true, "options": true, "name": true, "profile": true}
	for key := range object {
		if !allowed[key] {
			failHTTP(w, 400, "未知比较参数")
			return
		}
	}
	var action, name string
	var id, generation uint64
	var profile bool
	if json.Unmarshal(object["action"], &action) != nil || json.Unmarshal(object["id"], &id) != nil || json.Unmarshal(object["generation"], &generation) != nil {
		failHTTP(w, 400, "比较请求无效")
		return
	}
	if generation != data.Generation {
		writeJSON(w, 409, map[string]any{"error": "比较已更新，请重新读取。", "generation": data.Generation})
		return
	}
	if value := object["name"]; len(value) > 0 && json.Unmarshal(value, &name) != nil {
		failHTTP(w, 400, "工作表名称无效")
		return
	}
	if value := object["profile"]; len(value) > 0 && json.Unmarshal(value, &profile) != nil {
		failHTTP(w, 400, "日志参数无效")
		return
	}
	switch action {
	case "load", "view", "options", "sheet", "swap", "refresh":
	default:
		failHTTP(w, 400, "未知比较操作")
		return
	}
	view, err := readNativeView(object["view"])
	if err != nil {
		failHTTP(w, 400, err.Error())
		return
	}
	settings, err := readNativeSettings(object["settings"], data.Generation)
	if err != nil {
		failHTTP(w, 400, err.Error())
		return
	}
	var patch tableOptions
	if action == "options" {
		patch, err = normalizeOptions(object["options"])
		if err != nil {
			failHTTP(w, 400, err.Error())
			return
		}
	}
	started := time.Now()
	payload, err := data.native.payload(data, id, action, name, patch, settings, view)
	if err != nil {
		failHTTP(w, 400, err.Error())
		return
	}
	response := map[string]any{"id": id, "data": payload}
	if profile {
		response["metrics"] = []phaseMetric{{Phase: "native.compute", MS: float64(time.Since(started).Microseconds()) / 1000}}
	}
	s.touch()
	writeJSON(w, 200, response)
}
