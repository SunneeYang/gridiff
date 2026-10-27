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

const maxExpanded = 64 * 1024 * 1024
const maxCells = 1000000

var cellAddress = regexp.MustCompile(`^([A-Z]{1,3})([1-9][0-9]*)$`)

func validateArchive(data []byte) error {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return errors.New("文件不是有效的 XLSX 压缩包")
	}
	if len(archive.File) > 10000 {
		return errors.New("XLSX 压缩包文件数量超过 10000")
	}
	names := make(map[string]bool)
	var declared uint64
	var expanded int64
	cells, rows := 0, 0
	for _, entry := range archive.File {
		name := strings.TrimSuffix(entry.Name, "/")
		if name == "" || path.Clean(name) != name || strings.HasPrefix(name, "/") || strings.HasPrefix(name, "../") || strings.Contains(name, "\\") || (len(name) > 1 && name[1] == ':') {
			return errors.New("XLSX 压缩包路径无效")
		}
		if names[entry.Name] {
			return errors.New("XLSX 压缩包包含重复文件")
		}
		names[entry.Name] = true
		if entry.Flags&1 != 0 {
			return errors.New("暂不支持加密的 XLSX")
		}
		if entry.UncompressedSize64 > maxExpanded || declared+entry.UncompressedSize64 > maxExpanded {
			return errors.New("XLSX 解压后超过 64 MiB，请缩小工作簿")
		}
		declared += entry.UncompressedSize64
		reader, err := entry.Open()
		if err != nil {
			return err
		}
		limit := &io.LimitedReader{R: reader, N: maxExpanded - expanded + 1}
		before := limit.N
		lower := strings.ToLower(entry.Name)
		if strings.HasSuffix(lower, ".xml") || strings.HasSuffix(lower, ".rels") {
			worksheet := strings.HasPrefix(entry.Name, "xl/worksheets/") && !strings.Contains(strings.TrimPrefix(entry.Name, "xl/worksheets/"), "/") && strings.HasSuffix(entry.Name, ".xml")
			err = validateXML(limit, worksheet, &rows, &cells)
		} else {
			_, err = io.Copy(io.Discard, limit)
		}
		expanded += before - limit.N
		closeErr := reader.Close()
		if expanded > maxExpanded {
			return errors.New("XLSX 解压后超过 64 MiB，请缩小工作簿")
		}
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if !names["xl/workbook.xml"] {
		return errors.New("文件不是有效的 XLSX 工作簿")
	}
	return nil
}

func validateXML(input io.Reader, worksheet bool, rows, cells *int) error {
	buffered := bufio.NewReader(input)
	prefix, _ := buffered.Peek(2)
	var source io.Reader = buffered
	convertedUTF16 := false
	if bytes.Equal(prefix, []byte{0xff, 0xfe}) || bytes.Equal(prefix, []byte{0xfe, 0xff}) {
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
	decoder := xml.NewDecoder(source)
	decoder.CharsetReader = func(charset string, reader io.Reader) (io.Reader, error) {
		if convertedUTF16 && (strings.EqualFold(charset, "utf-16") || strings.EqualFold(charset, "utf-16le") || strings.EqualFold(charset, "utf-16be")) {
			return reader, nil
		}
		return nil, errors.New("XLSX XML 编码不受支持")
	}
	currentRow, depth, roots := 0, 0, 0
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
