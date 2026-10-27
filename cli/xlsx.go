package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"io"
	"path"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

const maxExpanded = 128 * 1024 * 1024
const maxCells = 1000000

var cellAddress = regexp.MustCompile(`^([A-Z]{1,3})([1-9][0-9]*)$`)

func validateArchive(data []byte) error {
	_, err := prepareArchive(data, false, sheetSelection{Mode: "all"})
	return err
}

func prepareArchive(data []byte, compact bool, selection sheetSelection) ([]byte, error) {
	selection, err := selection.normalized()
	if err != nil {
		return nil, err
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, errors.New("文件不是有效的 XLSX 压缩包")
	}
	if len(archive.File) > 10000 {
		return nil, errors.New("XLSX 压缩包文件数量超过 10000")
	}
	var output bytes.Buffer
	var writer *zip.Writer
	if compact {
		writer = zip.NewWriter(&output)
		defer writer.Close()
	}
	changed := false
	names := make(map[string]bool)
	entries := make(map[string]*zip.File)
	var declared uint64
	var expanded int64
	cells, rows := 0, 0
	for _, entry := range archive.File {
		name := strings.TrimSuffix(entry.Name, "/")
		if name == "" || path.Clean(name) != name || strings.HasPrefix(name, "/") || strings.HasPrefix(name, "../") || strings.Contains(name, "\\") || (len(name) > 1 && name[1] == ':') {
			return nil, errors.New("XLSX 压缩包路径无效")
		}
		if names[entry.Name] {
			return nil, errors.New("XLSX 压缩包包含重复文件")
		}
		names[entry.Name] = true
		if entry.Flags&1 != 0 {
			return nil, errors.New("暂不支持加密的 XLSX")
		}
		if entry.UncompressedSize64 > maxExpanded || declared+entry.UncompressedSize64 > maxExpanded {
			return nil, errors.New("XLSX 解压后超过 128 MiB，请缩小工作簿")
		}
		declared += entry.UncompressedSize64
		entries[entry.Name] = entry
	}
	selected, err := worksheetPaths(entries, &expanded, selection)
	if err != nil {
		return nil, err
	}
	removed := false
	for _, entry := range archive.File {
		if unusedWorksheet(entry.Name, selected) {
			removed = true
			continue
		}
		// Metadata was already validated while resolving workbook order.
		if selected != nil && (entry.Name == "xl/workbook.xml" || entry.Name == "xl/_rels/workbook.xml.rels") {
			if writer != nil {
				if err := writer.Copy(entry); err != nil {
					return nil, err
				}
			}
			continue
		}
		reader, err := entry.Open()
		if err != nil {
			return nil, err
		}
		limit := &io.LimitedReader{R: reader, N: maxExpanded - expanded + 1}
		before := limit.N
		lower := strings.ToLower(entry.Name)
		var trimmed formulaXML
		if strings.HasSuffix(lower, ".xml") || strings.HasSuffix(lower, ".rels") {
			worksheet := strings.HasPrefix(entry.Name, "xl/worksheets/") && !strings.Contains(strings.TrimPrefix(entry.Name, "xl/worksheets/"), "/") && strings.HasSuffix(entry.Name, ".xml")
			var target *formulaXML
			if compact && worksheet {
				target = &trimmed
			}
			err = scanXML(limit, worksheet, &rows, &cells, target)
		} else {
			_, err = io.Copy(io.Discard, limit)
		}
		expanded += before - limit.N
		closeErr := reader.Close()
		if expanded > maxExpanded {
			return nil, errors.New("XLSX 解压后超过 128 MiB，请缩小工作簿")
		}
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if writer != nil {
			if trimmed.changed {
				changed = true
				part, createErr := writer.Create(entry.Name)
				if createErr != nil {
					return nil, createErr
				}
				if _, err := part.Write(trimmed.output.Bytes()); err != nil {
					return nil, err
				}
			} else if err := writer.Copy(entry); err != nil {
				return nil, err
			}
		}
	}
	if !names["xl/workbook.xml"] {
		return nil, errors.New("文件不是有效的 XLSX 工作簿")
	}
	if writer != nil {
		if err := writer.Close(); err != nil {
			return nil, err
		}
		if removed || changed && output.Len() < len(data) {
			return output.Bytes(), nil
		}
	}
	return data, nil
}

func validateXML(input io.Reader, worksheet bool, rows, cells *int) error {
	return scanXML(input, worksheet, rows, cells, nil)
}

// Keep the formula marker and attributes so ExcelJS retains cached-value types and empty-cell ranges.
type formulaXML struct {
	output  bytes.Buffer
	changed bool
}

// Fall back to the original ZIP rather than retaining a large XML part or token twice.
type formulaCapture struct {
	bytes.Buffer
	disabled bool
}

func (c *formulaCapture) Write(data []byte) (int, error) {
	if !c.disabled {
		if c.Len()+len(data) > maxBytes {
			c.disabled = true
			c.Buffer = bytes.Buffer{}
		} else {
			c.Buffer.Write(data)
		}
	}
	return len(data), nil
}

func scanXML(input io.Reader, worksheet bool, rows, cells *int, compact *formulaXML) error {
	return scanXMLTokens(input, worksheet, rows, cells, compact, nil)
}

func scanXMLTokens(input io.Reader, worksheet bool, rows, cells *int, compact *formulaXML, visit func(xml.Token) error) error {
	buffered := bufio.NewReader(input)
	prefix, _ := buffered.Peek(2)
	var source io.Reader = buffered
	convertedUTF16 := false
	if bytes.Equal(prefix, []byte{0xff, 0xfe}) || bytes.Equal(prefix, []byte{0xfe, 0xff}) {
		compact = nil // Preserve the original encoding for UTF-16 worksheet parts.
		convertedUTF16 = true
		// Only BOM-marked UTF-16 XML needs a temporary conversion; ZIP expansion stays bounded.
		data, err := io.ReadAll(buffered)
		if err != nil {
			return err
		}
		if len(data)%2 != 0 {
			return errors.New("XLSX XML 的 UTF-16 编码无效")
		}
		var order binary.ByteOrder = binary.LittleEndian
		if data[0] == 0xfe {
			order = binary.BigEndian
		}
		units := make([]uint16, (len(data)-2)/2)
		for i := range units {
			units[i] = order.Uint16(data[2+i*2:])
		}
		for i := 0; i < len(units); i++ {
			if units[i] >= 0xd800 && units[i] <= 0xdbff {
				if i+1 >= len(units) || units[i+1] < 0xdc00 || units[i+1] > 0xdfff {
					return errors.New("XLSX XML 的 UTF-16 编码无效")
				}
				i++
			} else if units[i] >= 0xdc00 && units[i] <= 0xdfff {
				return errors.New("XLSX XML 的 UTF-16 编码无效")
			}
		}
		source = strings.NewReader(string(utf16.Decode(units)))
	} else if prefix, _ := buffered.Peek(3); bytes.Equal(prefix, []byte{0xef, 0xbb, 0xbf}) {
		_, _ = buffered.Discard(3)
	}
	var captured formulaCapture
	if compact != nil {
		source = io.TeeReader(source, &captured)
	}
	decoder := xml.NewDecoder(source)
	decoder.CharsetReader = func(charset string, reader io.Reader) (io.Reader, error) {
		if convertedUTF16 && (strings.EqualFold(charset, "utf-16") || strings.EqualFold(charset, "utf-16le") || strings.EqualFold(charset, "utf-16be")) {
			return reader, nil
		}
		return nil, errors.New("XLSX XML 编码不受支持")
	}
	currentRow, depth, roots := 0, 0, 0
	var parents []xml.Name
	var offset int64
	formulaDepth, formulaText := 0, false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			if depth != 0 || roots != 1 {
				return errors.New("XLSX XML 结构无效")
			}
			return nil
		}
		if err != nil {
			return err
		}
		if visit != nil {
			if err := visit(token); err != nil {
				return err
			}
		}
		if compact != nil {
			end := decoder.InputOffset()
			var raw []byte
			if !captured.disabled {
				raw = captured.Next(int(end - offset))
			}
			offset = end
			value, text := token.(xml.CharData)
			// ExcelJS ignores CDATA events; converting them to ordinary text changes empty-cell semantics.
			formula := text && formulaDepth > 0 && !bytes.HasPrefix(raw, []byte("<![CDATA["))
			growth := len(raw)
			if formula {
				growth = 0
				if len(value) > 0 && !formulaText {
					growth = 1
				}
			}
			if captured.disabled || compact.output.Len()+growth > maxBytes {
				compact.output = bytes.Buffer{}
				compact.changed = false
				compact = nil
				captured.disabled = true
				captured.Buffer = bytes.Buffer{}
			} else if formula {
				if len(value) > 0 && !formulaText {
					compact.output.WriteByte('0')
					formulaText = true
				}
				compact.changed = true
			} else {
				compact.output.Write(raw)
			}
		}
		if compact != nil {
			if value, ok := token.(xml.StartElement); ok {
				if worksheetFormula(parents, value.Name) {
					formulaDepth = len(parents) + 1
					formulaText = false
				}
				parents = append(parents, value.Name)
			} else if _, ok := token.(xml.EndElement); ok {
				if formulaDepth == len(parents) {
					formulaDepth = 0
				}
				parents = parents[:len(parents)-1]
			}
		}
		switch value := token.(type) {
		case xml.Directive:
			if strings.HasPrefix(strings.ToUpper(strings.TrimSpace(string(value))), "DOCTYPE") {
				return errors.New("XLSX XML 不允许包含 DTD")
			}
		case xml.StartElement:
			if depth == 0 {
				roots++
				if roots > 1 {
					return errors.New("XLSX XML 结构无效")
				}
			}
			depth++
			if !worksheet {
				continue
			}
			attribute := ""
			for _, a := range value.Attr {
				if a.Name.Local == "r" && a.Name.Space == "" {
					attribute = a.Value
				}
			}
			if value.Name.Local == "row" {
				*rows++
				currentRow, err = strconv.Atoi(attribute)
				if err != nil || *rows > maxCells || currentRow < 1 || currentRow > 1048576 {
					return errors.New("XLSX 行范围过大或行号无效")
				}
			}
			if value.Name.Local == "c" {
				*cells++
				match := cellAddress.FindStringSubmatch(attribute)
				if *cells > maxCells || match == nil {
					return errors.New("XLSX 超过 100 万单元格或单元格坐标无效")
				}
				column := 0
				for _, letter := range match[1] {
					column = column*26 + int(letter-'A') + 1
				}
				row, err := strconv.Atoi(match[2])
				if err != nil || column > 16384 || row != currentRow {
					return errors.New("XLSX 超过 100 万单元格或单元格坐标无效")
				}
			}
		case xml.EndElement:
			depth--
		case xml.CharData:
			if depth == 0 && len(bytes.TrimSpace(value)) > 0 {
				return errors.New("XLSX XML 结构无效")
			}
		}
	}
}

func worksheetFormula(parents []xml.Name, name xml.Name) bool {
	if len(parents) != 4 || name.Local != "f" {
		return false
	}
	if name.Space != "" && name.Space != "http://schemas.openxmlformats.org/spreadsheetml/2006/main" && name.Space != "http://purl.oclc.org/ooxml/spreadsheetml/main" {
		return false
	}
	for i, local := range []string{"worksheet", "sheetData", "row", "c"} {
		if parents[i].Local != local || parents[i].Space != name.Space {
			return false
		}
	}
	return true
}
