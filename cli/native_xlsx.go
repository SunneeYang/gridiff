package main

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/xuri/excelize/v2"
)

// The native reader validates and consumes each selected ZIP member once. It
// never rebuilds the ZIP or retains formula expressions, drawings or XML trees.
type nativeArchive struct {
	files       []*zip.File
	entries     map[string]*zip.File
	read        map[string]bool
	expanded    int64
	rows, cells int
}

func openNativeArchive(data []byte) (*nativeArchive, error) {
	if len(data) > maxBytes {
		return nil, errors.New("单侧文件超过 8 MiB，请缩小表格或工作簿")
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, errors.New("文件不是有效的 XLSX 压缩包")
	}
	if len(reader.File) > 10000 {
		return nil, errors.New("XLSX 压缩包文件数量超过 10000")
	}
	a := &nativeArchive{files: reader.File, entries: make(map[string]*zip.File), read: make(map[string]bool)}
	var declared uint64
	for _, entry := range reader.File {
		name := strings.TrimSuffix(entry.Name, "/")
		if name == "" || path.Clean(name) != name || strings.HasPrefix(name, "/") || strings.HasPrefix(name, "../") || strings.Contains(name, "\\") || (len(name) > 1 && name[1] == ':') {
			return nil, errors.New("XLSX 压缩包路径无效")
		}
		if a.entries[entry.Name] != nil {
			return nil, errors.New("XLSX 压缩包包含重复文件")
		}
		if entry.Flags&1 != 0 {
			return nil, errors.New("暂不支持加密的 XLSX")
		}
		if entry.UncompressedSize64 > maxExpanded || declared+entry.UncompressedSize64 > maxExpanded {
			return nil, errors.New("XLSX 解压后超过 128 MiB，请缩小工作簿")
		}
		declared += entry.UncompressedSize64
		a.entries[entry.Name] = entry
	}
	if a.entries["xl/workbook.xml"] == nil {
		return nil, errors.New("文件不是有效的 XLSX 工作簿")
	}
	return a, nil
}

func (a *nativeArchive) scan(name string, worksheet bool, visit func(xml.Token) error) error {
	entry := a.entries[name]
	if entry == nil {
		return errors.New("XLSX 缺少工作簿或工作表关系信息")
	}
	reader, err := entry.Open()
	if err != nil {
		return err
	}
	limit := &io.LimitedReader{R: reader, N: maxExpanded - a.expanded + 1}
	before := limit.N
	lower := strings.ToLower(name)
	if strings.HasSuffix(lower, ".xml") || strings.HasSuffix(lower, ".rels") {
		err = scanXMLTokens(limit, worksheet, &a.rows, &a.cells, visit)
	} else {
		_, err = io.Copy(io.Discard, limit)
	}
	a.expanded += before - limit.N
	closeErr := reader.Close()
	if a.expanded > maxExpanded {
		return errors.New("XLSX 解压后超过 128 MiB，请缩小工作簿")
	}
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	a.read[name] = true
	return nil
}

func nativeAttr(value xml.StartElement, name string) string {
	for _, attr := range value.Attr {
		if attr.Name.Local == name && attr.Name.Space == "" {
			return attr.Value
		}
	}
	return ""
}

type nativeSheetRef struct{ name, id, member string }

func (a *nativeArchive) workbook(selection sheetSelection) ([]nativeSheetRef, bool, error) {
	refs := []nativeSheetRef{}
	date1904 := false
	wanted := make(map[string]bool)
	for _, name := range selection.Names {
		wanted[name] = true
	}
	var stack []xml.Name
	index := 0
	ids := make(map[string]bool)
	err := a.scan("xl/workbook.xml", false, func(token xml.Token) error {
		switch value := token.(type) {
		case xml.StartElement:
			if len(stack) == 0 && (value.Name.Local != "workbook" || value.Name.Space != spreadsheetNS && value.Name.Space != strictSpreadsheetNS && value.Name.Space != "") {
				return errors.New("XLSX 工作簿命名空间无效或不受支持")
			}
			if len(stack) == 1 && value.Name.Local == "workbookPr" {
				flag := nativeAttr(value, "date1904")
				date1904 = flag == "1" || flag == "true"
			}
			if len(stack) == 2 && stack[1].Local == "sheets" && value.Name.Local == "sheet" {
				name := nativeAttr(value, "name")
				choose := selection.Mode == "all" || selection.Mode == "named" && wanted[name] || selection.Mode == "first" && index == 0
				index++
				if choose {
					if value.Name.Space != stack[0].Space || stack[1].Space != stack[0].Space {
						return errors.New("XLSX 所选工作表命名空间无效")
					}
					id := ""
					for _, attr := range value.Attr {
						if attr.Name.Local == "id" && (attr.Name.Space == relationshipNS || attr.Name.Space == strictRelationshipNS) {
							id = attr.Value
						}
					}
					if id == "" {
						return errors.New("XLSX 所选工作表缺少关系标识")
					}
					if ids[id] {
						return errors.New("XLSX 所选工作表关系标识重复")
					}
					ids[id] = true
					refs = append(refs, nativeSheetRef{name: name, id: id})
				}
			}
			stack = append(stack, value.Name)
		case xml.EndElement:
			stack = stack[:len(stack)-1]
		}
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	if len(refs) == 0 && a.entries["xl/_rels/workbook.xml.rels"] == nil {
		return refs, date1904, nil
	}
	targets := make(map[string]string)
	seen := make(map[string]bool)
	err = a.scan("xl/_rels/workbook.xml.rels", false, func(token xml.Token) error {
		switch value := token.(type) {
		case xml.StartElement:
			if len(stack) == 1 && stack[0] == (xml.Name{Space: packageRelationshipNS, Local: "Relationships"}) && value.Name == (xml.Name{Space: packageRelationshipNS, Local: "Relationship"}) {
				id := nativeAttr(value, "Id")
				if id == "" || seen[id] {
					return errors.New("XLSX 工作表关系标识无效或重复")
				}
				seen[id] = true
				if ids[id] {
					target, kind, mode := nativeAttr(value, "Target"), nativeAttr(value, "Type"), nativeAttr(value, "TargetMode")
					if (kind != relationshipNS+"/worksheet" && kind != strictRelationshipNS+"/worksheet") || (mode != "" && mode != "Internal") || target == "" || strings.ContainsAny(target, "\\?#:") || path.Clean(target) != target || strings.HasPrefix(target, "../") {
						return errors.New("XLSX 所选工作表关系无效")
					}
					member := strings.TrimPrefix(target, "/")
					if !strings.HasPrefix(target, "/") {
						member = "xl/" + target
					}
					if !strings.HasPrefix(member, "xl/worksheets/") || strings.Contains(strings.TrimPrefix(member, "xl/worksheets/"), "/") || !strings.HasSuffix(member, ".xml") || a.entries[member] == nil {
						return errors.New("XLSX 所选工作表不存在或路径无效")
					}
					targets[id] = member
				}
			}
			stack = append(stack, value.Name)
		case xml.EndElement:
			stack = stack[:len(stack)-1]
		}
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	for i := range refs {
		refs[i].member = targets[refs[i].id]
		if refs[i].member == "" {
			return nil, false, errors.New("XLSX 找不到所选工作表的关系")
		}
	}
	return refs, date1904, nil
}

type nativeSharedString struct {
	text string
	rich bool
}

func (a *nativeArchive) sharedStrings() ([]nativeSharedString, error) {
	result := []nativeSharedString{}
	if a.entries["xl/sharedStrings.xml"] == nil {
		return result, nil
	}
	var stack []string
	var text, part strings.Builder
	rich := false
	err := a.scan("xl/sharedStrings.xml", false, func(token xml.Token) error {
		switch value := token.(type) {
		case xml.StartElement:
			if len(stack) == 1 && value.Name.Local == "si" {
				text.Reset()
				rich = false
			}
			if len(stack) == 2 && stack[1] == "si" && value.Name.Local == "r" {
				rich = true
			}
			if value.Name.Local == "t" {
				part.Reset()
			}
			stack = append(stack, value.Name.Local)
		case xml.CharData:
			if len(stack) == 3 && stack[1] == "si" && stack[2] == "t" || len(stack) == 4 && stack[1] == "si" && stack[2] == "r" && stack[3] == "t" {
				part.Write(value)
			}
		case xml.EndElement:
			if len(stack) == 3 && stack[1] == "si" && stack[2] == "t" || len(stack) == 4 && stack[1] == "si" && stack[2] == "r" && stack[3] == "t" {
				text.WriteString(nativeTextEscapes(part.String()))
			}
			if len(stack) == 2 && stack[1] == "si" {
				result = append(result, nativeSharedString{text.String(), rich})
			}
			stack = stack[:len(stack)-1]
		}
		return nil
	})
	return result, err
}

var nativeBuiltinFormats = map[int]string{
	0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
	14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: `m/d/yy "h":mm`,
	37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00 ;(#,##0.00)", 40: "#,##0.00 ;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@",
}

var nativeFormatLiteral = regexp.MustCompile(`\[[^\]]*\]|"[^"]*"`)
var nativeDateFormat = regexp.MustCompile(`[ymdhMsb]+`)

type nativeStyle struct {
	format string
	date   bool
}

func (a *nativeArchive) styles() ([]nativeStyle, error) {
	if a.entries["xl/styles.xml"] == nil {
		return nil, nil
	}
	formats := make(map[int]string)
	for id, format := range nativeBuiltinFormats {
		formats[id] = format
	}
	var stack []string
	var ids []int
	err := a.scan("xl/styles.xml", false, func(token xml.Token) error {
		switch value := token.(type) {
		case xml.StartElement:
			if len(stack) == 2 && stack[1] == "numFmts" && value.Name.Local == "numFmt" {
				id, _ := strconv.Atoi(nativeAttr(value, "numFmtId"))
				formats[id] = nativeAttr(value, "formatCode")
			}
			if len(stack) == 2 && stack[1] == "cellXfs" && value.Name.Local == "xf" {
				id, _ := strconv.Atoi(nativeAttr(value, "numFmtId"))
				ids = append(ids, id)
			}
			stack = append(stack, value.Name.Local)
		case xml.EndElement:
			stack = stack[:len(stack)-1]
		}
		return nil
	})
	styles := make([]nativeStyle, len(ids))
	for i, id := range ids {
		format := formats[id]
		styles[i] = nativeStyle{format, nativeDateFormat.MatchString(nativeFormatLiteral.ReplaceAllString(format, ""))}
	}
	return styles, err
}

type nativeFormatKey struct {
	format string
	value  float64
}

type nativeNumberFormatter struct {
	cache    map[nativeFormatKey]string
	book     *excelize.File
	styles   map[string]int
	date1904 bool
}

func (f *nativeNumberFormatter) close() {
	if f.book != nil {
		_ = f.book.Close()
	}
}

func nativeNumberString(value float64) string {
	if value == 0 {
		return "0"
	}
	text := strconv.FormatFloat(value, 'e', -1, 64)
	parts := strings.Split(text, "e")
	exponent, _ := strconv.Atoi(parts[1])
	if exponent < -6 || exponent >= 21 {
		sign := "+"
		if exponent < 0 {
			sign = ""
		}
		return parts[0] + "e" + sign + strconv.Itoa(exponent)
	}
	negative := strings.HasPrefix(parts[0], "-")
	digits := strings.ReplaceAll(strings.TrimPrefix(parts[0], "-"), ".", "")
	position := exponent + 1
	switch {
	case position <= 0:
		text = "0." + strings.Repeat("0", -position) + digits
	case position >= len(digits):
		text = digits + strings.Repeat("0", position-len(digits))
	default:
		text = digits[:position] + "." + digits[position:]
	}
	if negative {
		text = "-" + text
	}
	return text
}

func (f *nativeNumberFormatter) format(format string, value float64) (string, error) {
	if format == "" || format == "General" || format == "@" {
		return nativeGeneral(value), nil
	}
	if text, ok := nativeDecoratedNumber(format, value); ok {
		return text, nil
	}
	if (value < 0 || value > 2958465) && (nativeDateFormat.MatchString(nativeFormatLiteral.ReplaceAllString(format, "")) || strings.Contains(format, "[h]") || strings.Contains(format, "[m]") || strings.Contains(format, "[s]")) {
		return "", nil
	}
	if nativeDateFormat.MatchString(nativeFormatLiteral.ReplaceAllString(format, "")) {
		seconds := (value - math.Floor(value)) * 86400
		if seconds-math.Floor(seconds) > 0.9999 {
			value = math.Floor(value) + math.Ceil(seconds)/86400
		}
		if text, ok := nativeFractionalTime(format, value); ok {
			return text, nil
		}
	}
	key := nativeFormatKey{format, value}
	if text, ok := f.cache[key]; ok {
		return text, nil
	}
	if f.book == nil {
		f.book = excelize.NewFile()
		f.styles = make(map[string]int)
		if err := f.book.SetWorkbookProps(&excelize.WorkbookPropsOptions{Date1904: &f.date1904}); err != nil {
			return "", err
		}
	}
	id, ok := f.styles[format]
	if !ok {
		var err error
		id, err = f.book.NewStyle(&excelize.Style{CustomNumFmt: &format})
		if err != nil {
			return "", err
		}
		f.styles[format] = id
	}
	if err := f.book.SetCellFloat("Sheet1", "A1", value, -1, 64); err != nil {
		return "", err
	}
	if err := f.book.SetCellStyle("Sheet1", "A1", "A1", id); err != nil {
		return "", err
	}
	text, err := f.book.GetCellValue("Sheet1", "A1")
	// A '#' mixed-fraction whole-part placeholder is blank below one in SSF.
	if math.Abs(value) < 1 && strings.HasPrefix(format, "# ") && strings.Contains(format, "/") {
		if strings.Contains(text, "/") {
			text = strings.TrimPrefix(text, "0")
			text = strings.Replace(text, "-0", "-", 1)
		}
	}
	// Bound cache growth when every cell uses a different date or uncommon format.
	if err == nil && len(f.cache) < 1024 {
		if f.cache == nil {
			f.cache = make(map[nativeFormatKey]string)
		}
		f.cache[key] = text
	}
	return text, err
}

// SSF General uses Excel's display precision rather than the full raw number.
// Adapted from SSF 0.11.2 (Copyright SheetJS LLC, Apache-2.0), implemented in Go.
func nativeGeneral(value float64) string {
	if value == 0 {
		return "0"
	}
	if math.Trunc(value) == value && value >= -2147483648 && value <= 2147483647 {
		return nativeNumberString(value)
	}
	exponent := int(math.Floor(math.Log10(math.Abs(value))))
	width := 11
	if value < 0 {
		width = 12
	}
	var text string
	switch {
	case exponent >= -4 && exponent <= -1:
		text = nativePrecision(value, 10+exponent)
	case exponent >= -9 && exponent <= 9:
		text = nativeStripDecimal(strconv.FormatFloat(value, 'f', 12, 64))
		if len(text) > width {
			text = nativePrecision(value, 10)
			if len(text) > width {
				text = strconv.FormatFloat(value, 'e', 5, 64)
			}
		}
	case exponent == 10:
		text = strconv.FormatFloat(value, 'f', 10, 64)
		if len(text) > 12 {
			text = text[:12]
		}
	default:
		text = nativeStripDecimal(strconv.FormatFloat(value, 'f', 11, 64))
		if len(text) > width || text == "0" || text == "-0" {
			text = nativePrecision(value, 6)
		}
	}
	parts := strings.Split(strings.ToUpper(text), "E")
	parts[0] = nativeStripDecimal(parts[0])
	if len(parts) == 1 {
		return parts[0]
	}
	exp, _ := strconv.Atoi(parts[1])
	return parts[0] + fmt.Sprintf("E%+03d", exp)
}

func nativeStripDecimal(value string) string {
	if !strings.Contains(value, ".") {
		return value
	}
	return strings.TrimSuffix(strings.TrimRight(value, "0"), ".")
}

func nativePrecision(value float64, precision int) string {
	text := strconv.FormatFloat(value, 'e', precision-1, 64)
	parts := strings.Split(text, "e")
	exp, _ := strconv.Atoi(parts[1])
	if exp >= -6 && exp < precision {
		return strconv.FormatFloat(value, 'f', precision-exp-1, 64)
	}
	if exp < 0 {
		return parts[0] + "e" + strconv.Itoa(exp)
	}
	return parts[0] + "e+" + strconv.Itoa(exp)
}

var nativeSimpleFormat = regexp.MustCompile(`^(0+)(?:\.(0+))?(%)?$`)

func nativeSimpleNumber(format string, value float64) (string, bool) {
	match := nativeSimpleFormat.FindStringSubmatch(format)
	if match == nil {
		return "", false
	}
	if match[3] != "" {
		value *= 100
	}
	precision := len(match[2])
	if precision > 15 || len(match[1]) > 20 {
		return "", false
	}
	sign := ""
	if precision == 0 && len(match[1]) > 1 && value < 0 {
		sign = "-"
		value = -value
	}
	scale := math.Pow10(precision)
	rounded := nativeJSRound(value*scale) / scale
	text := nativeNumberString(rounded)
	if strings.Contains(text, "e") {
		return text + match[3], true
	}
	parts := strings.SplitN(text, ".", 2)
	whole := strings.TrimPrefix(parts[0], "-")
	if len(whole) < len(match[1]) {
		text = strings.Repeat("0", len(match[1])-len(whole)) + text
	}
	if precision > 0 {
		if len(parts) == 1 {
			text += "." + strings.Repeat("0", precision)
		} else if len(parts[1]) < precision {
			text += strings.Repeat("0", precision-len(parts[1]))
		}
	}
	return sign + text + match[3], true
}

//go:noinline
func nativeJSRound(value float64) float64 {
	whole := math.Floor(value)
	if value-whole >= 0.5 {
		return whole + 1
	}
	return whole
}

type nativeCell struct {
	row, col, style                                         int
	address, kind                                           string
	value, inline, inlinePart                               strings.Builder
	valuePresent, inlinePresent, rich, formula, formulaText bool
}
type nativeParsedCell struct {
	row, col int
	text     string
	meta     cellMetadata
	hasValue bool
}

func (c *nativeCell) parsed(shared []nativeSharedString, styles []nativeStyle, formatter *nativeNumberFormatter) (nativeParsedCell, bool, error) {
	result := nativeParsedCell{row: c.row, col: c.col}
	var style nativeStyle
	if c.style >= 0 && c.style < len(styles) {
		style = styles[c.style]
	}
	formula := c.formula || c.formulaText
	value := c.value.String()
	kind := c.kind
	if !c.valuePresent && !c.inlinePresent && !formula {
		return result, false, nil
	}
	result.hasValue = formula
	result.meta.Type = "empty"
	if formula && value == "" {
		return result, true, nil
	}
	if formula && style.date {
		// ExcelJS applies a date style to every cached formula result, including
		// numeric strings and booleans, using JavaScript numeric coercion.
		switch kind {
		case "b":
			if value != "0" {
				value = "1"
			} else {
				value = "0"
			}
		case "str":
			value = strings.TrimSpace(nativeXMLDecode(value))
			if value == "" {
				value = "0"
			}
		case "e":
			return result, false, fmt.Errorf("单元格 %s 的日期无效。", c.address)
		}
		kind = "n"
	}
	if kind == "s" && !formula {
		index, err := strconv.Atoi(value)
		if err != nil || index < 0 || index >= len(shared) {
			return result, false, fmt.Errorf("单元格 %s 的共享字符串无效", c.address)
		}
		result.text = shared[index].text
		result.hasValue = result.text != "" || shared[index].rich
		result.meta = cellMetadata{Type: "string", Raw: result.text}
		return result, true, nil
	}
	if kind == "inlineStr" && !formula || kind == "str" {
		if kind == "inlineStr" {
			value = c.inline.String()
		} else {
			value = nativeXMLDecode(value)
		}
		result.text = value
		result.hasValue = result.hasValue || value != "" || c.rich
		result.meta = cellMetadata{Type: "string", Raw: value}
		return result, true, nil
	}
	if kind == "b" {
		truth := value != "0"
		result.text = "FALSE"
		if truth {
			result.text = "TRUE"
		}
		result.hasValue = true
		result.meta = cellMetadata{Type: "boolean", Raw: truth}
		return result, true, nil
	}
	if kind == "e" {
		result.text = value
		result.hasValue = true
		result.meta = cellMetadata{Type: "error", Raw: value}
		return result, true, nil
	}
	number, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsInf(number, 0) || math.IsNaN(number) || !style.date && math.Trunc(number) == number && math.Abs(number) > 9007199254740991 {
		return result, false, fmt.Errorf("单元格 %s 的数值超出安全精度，请在源文件中将长 ID 保存为文本。", c.address)
	}
	result.meta = cellMetadata{Type: "number", Raw: number}
	result.hasValue = true
	if style.date {
		offset := float64(0)
		if formatter.date1904 {
			offset = 1462
		}
		ms := math.Floor((number-25569+offset)*86400000 + 0.5)
		if math.IsNaN(ms) || math.IsInf(ms, 0) || math.Abs(ms) > 8640000000000000 {
			return result, false, fmt.Errorf("单元格 %s 的日期无效。", c.address)
		}
		date := time.UnixMilli(int64(ms)).UTC()
		rawDate := date.Format("2006-01-02T15:04:05.000Z")
		if date.Year() < 0 || date.Year() > 9999 {
			rawDate = fmt.Sprintf("%+07d", date.Year()) + date.Format("-01-02T15:04:05.000Z")
		}
		result.meta = cellMetadata{Type: "date", Raw: rawDate}
		number = 25569 + ms/86400000 - offset
	}
	result.text, err = formatter.format(style.format, number)
	if err != nil || result.text == "" {
		if result.meta.Type == "number" {
			result.text = nativeNumberString(number)
		} else {
			result.text = fmt.Sprint(result.meta.Raw)
		}
	}
	return result, true, nil
}

var nativeXMLDecodeReplacer = strings.NewReplacer("&lt;", "<", "&gt;", ">", "&amp;", "&", "&apos;", "'", "&quot;", "\"")

func nativeXMLDecode(text string) string { return nativeXMLDecodeReplacer.Replace(text) }

var nativeEscapePattern = regexp.MustCompile(`_x([0-9A-F]{4})_`)

func nativeTextEscapes(text string) string {
	matches := nativeEscapePattern.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return text
	}
	var units []uint16
	start := 0
	for _, match := range matches {
		units = append(units, utf16.Encode([]rune(text[start:match[0]]))...)
		value, _ := strconv.ParseUint(text[match[2]:match[3]], 16, 16)
		units = append(units, uint16(value))
		start = match[1]
	}
	units = append(units, utf16.Encode([]rune(text[start:]))...)
	return string(utf16.Decode(units))
}

func (a *nativeArchive) worksheet(ref nativeSheetRef, shared []nativeSharedString, styles []nativeStyle, formatter *nativeNumberFormatter, area *int) (rawSheet, error) {
	result := rawSheet{Name: ref.name, Values: [][]string{}, Metadata: [][]cellMetadata{}}
	cells := make([]nativeParsedCell, 0)
	var stack []string
	var cell *nativeCell
	height, width := 0, 0
	err := a.scan(ref.member, true, func(token xml.Token) error {
		switch value := token.(type) {
		case xml.StartElement:
			if len(stack) == 3 && stack[0] == "worksheet" && stack[1] == "sheetData" && stack[2] == "row" && value.Name.Local == "c" {
				address := nativeAttr(value, "r")
				match := cellAddress.FindStringSubmatch(address)
				if match == nil {
					return errors.New("XLSX 单元格坐标无效")
				}
				row, err := strconv.Atoi(match[2])
				if err != nil {
					return err
				}
				col := 0
				for _, letter := range match[1] {
					col = col*26 + int(letter-'A') + 1
				}
				style, _ := strconv.Atoi(nativeAttr(value, "s"))
				cell = &nativeCell{address: address, kind: nativeAttr(value, "t"), row: row, col: col, style: style}
			} else if cell != nil {
				if len(stack) == 4 && value.Name.Local == "f" {
					kind := nativeAttr(value, "t")
					cell.formula = kind == "shared" || kind == "array"
				}
				if len(stack) == 5 && stack[4] == "is" && value.Name.Local == "r" {
					cell.rich = true
				}
				if len(stack) == 6 && stack[4] == "is" && stack[5] == "r" && value.Name.Local == "t" {
					cell.inlinePresent = true
					cell.inlinePart.Reset()
				}
			}
			stack = append(stack, value.Name.Local)
		case xml.CharData:
			if cell != nil {
				if len(stack) == 5 && stack[4] == "f" && len(value) > 0 {
					cell.formulaText = true
				}
				if len(stack) == 5 && stack[4] == "v" {
					cell.valuePresent = true
					cell.value.Write(value)
				}
				if len(stack) == 6 && stack[4] == "is" && stack[5] == "t" {
					cell.inlinePresent = true
					cell.inline.Write(value)
				}
				if len(stack) == 7 && stack[4] == "is" && stack[5] == "r" && stack[6] == "t" {
					cell.inlinePart.Write(value)
				}
			}
		case xml.EndElement:
			if cell != nil && len(stack) == 7 && stack[4] == "is" && stack[5] == "r" && stack[6] == "t" {
				cell.inline.WriteString(nativeTextEscapes(cell.inlinePart.String()))
			}
			if cell != nil && len(stack) == 4 && stack[3] == "c" {
				parsed, keep, err := cell.parsed(shared, styles, formatter)
				if err != nil {
					return err
				}
				if keep {
					cells = append(cells, parsed)
					if parsed.hasValue {
						height = max(height, parsed.row)
						width = max(width, parsed.col)
						if height*width > maxCells-*area {
							return errors.New("XLSX 有值区域超过 100 万单元格，请缩小工作簿（包含区域内的空白）。")
						}
					}
				}
				cell = nil
			}
			stack = stack[:len(stack)-1]
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	*area += height * width
	result.Values = make([][]string, height)
	result.Metadata = make([][]cellMetadata, height)
	for i := range result.Values {
		result.Values[i] = []string{}
		result.Metadata[i] = []cellMetadata{}
	}
	for _, cell := range cells {
		if cell.row > height || cell.col > width {
			continue
		}
		row, col := cell.row-1, cell.col-1
		for len(result.Values[row]) <= col {
			result.Values[row] = append(result.Values[row], "")
			result.Metadata[row] = append(result.Metadata[row], cellMetadata{})
		}
		result.Values[row][col] = cell.text
		result.Metadata[row][col] = cell.meta
	}
	for i, row := range result.Values {
		for len(row) > 0 && row[len(row)-1] == "" {
			row = row[:len(row)-1]
		}
		result.Values[i] = row
	}
	return result, nil
}

func readNativeWorkbook(data []byte, selection sheetSelection) ([]rawSheet, []phaseMetric, error) {
	start := time.Now()
	selection, err := selection.normalized()
	if err != nil {
		return nil, nil, err
	}
	if len(data) == 0 {
		return []rawSheet{}, nil, nil
	}
	a, err := openNativeArchive(data)
	if err != nil {
		return nil, nil, err
	}
	refs, date1904, err := a.workbook(selection)
	if err != nil {
		return nil, nil, err
	}
	shared, err := a.sharedStrings()
	if err != nil {
		return nil, nil, err
	}
	styles, err := a.styles()
	if err != nil {
		return nil, nil, err
	}
	metrics := []phaseMetric{{Phase: "native.xlsx_metadata", MS: float64(time.Since(start).Microseconds()) / 1000, Bytes: int(a.expanded)}}
	start = time.Now()
	parsedBytes := a.expanded
	formatter := &nativeNumberFormatter{date1904: date1904}
	defer formatter.close()
	selected := make(map[string]bool)
	result := make([]rawSheet, 0, len(refs))
	area := 0
	for _, ref := range refs {
		selected[ref.member] = true
		selected["xl/worksheets/_rels/"+path.Base(ref.member)+".rels"] = true
		sheet, err := a.worksheet(ref, shared, styles, formatter, &area)
		if err != nil {
			return nil, metrics, err
		}
		result = append(result, sheet)
	}
	metrics = append(metrics, phaseMetric{Phase: "native.xlsx_worksheets", MS: float64(time.Since(start).Microseconds()) / 1000, Bytes: int(a.expanded - parsedBytes), Cells: area})
	start = time.Now()
	parsedBytes = a.expanded
	for _, entry := range a.files {
		if a.read[entry.Name] || selection.Mode != "all" && unusedWorksheet(entry.Name, selected) {
			continue
		}
		worksheet := strings.HasPrefix(entry.Name, "xl/worksheets/") && !strings.Contains(strings.TrimPrefix(entry.Name, "xl/worksheets/"), "/") && strings.HasSuffix(entry.Name, ".xml")
		if err := a.scan(entry.Name, worksheet, nil); err != nil {
			return nil, metrics, err
		}
	}
	metrics = append(metrics, phaseMetric{Phase: "native.xlsx_validate_other", MS: float64(time.Since(start).Microseconds()) / 1000, Bytes: int(a.expanded - parsedBytes)})
	return result, metrics, nil
}
