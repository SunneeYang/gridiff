package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

const maxExpanded = 128 * 1024 * 1024
const maxCells = 1000000

var cellAddress = regexp.MustCompile(`^([A-Z]{1,3})([1-9][0-9]*)$`)

// The plugin ignores CDATA events. encoding/xml merges their type with ordinary
// text, so remember only each token's opening bytes. The decoder can read ahead;
// the last bounded read chunk supplies prefixes already buffered inside it.
type xmlPrefixReader struct {
	source     io.Reader
	end, start int64
	last       []byte
	prefix     [9]byte
	length     int
}

func (r *xmlPrefixReader) begin(start int64) {
	r.start, r.length = start, 0
	base := r.end - int64(len(r.last))
	if start >= base && start < r.end {
		r.length = copy(r.prefix[:], r.last[start-base:])
	}
}

func (r *xmlPrefixReader) Read(buffer []byte) (int, error) {
	if len(buffer) > 4096 {
		buffer = buffer[:4096]
	}
	n, err := r.source.Read(buffer)
	next := r.start + int64(r.length)
	if r.length < len(r.prefix) && next >= r.end && next < r.end+int64(n) {
		r.length += copy(r.prefix[r.length:], buffer[next-r.end:n])
	}
	r.end += int64(n)
	if n > 0 {
		r.last = append(r.last[:0], buffer[:n]...)
	}
	return n, err
}

func (r *xmlPrefixReader) cdata() bool { return r.length == 9 && string(r.prefix[:]) == "<![CDATA[" }

func scanXMLTokens(input io.Reader, worksheet bool, rows, cells *int, visit func(xml.Token) error) error {
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
	var lexical *xmlPrefixReader
	if visit != nil {
		lexical = &xmlPrefixReader{source: source}
		source = lexical
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
		if lexical != nil {
			lexical.begin(decoder.InputOffset())
		}
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
			_, text := token.(xml.CharData)
			if !text || !lexical.cdata() {
				if err := visit(token); err != nil {
					return err
				}
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
