package main

import (
	"encoding/json"
	"encoding/xml"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNativeXLSXValuesAndSafety(t *testing.T) {
	entries := map[string][]byte{
		"xl/workbook.xml":          []byte(`<workbook/>`),
		"xl/sharedStrings.xml":     []byte(`<sst><si><t>id</t></si><si><r><t>hello</t></r><r><t>世界</t></r></si></sst>`),
		"xl/styles.xml":            []byte(`<styleSheet><numFmts><numFmt numFmtId="164" formatCode="0.0%"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>`),
		"xl/worksheets/sheet1.xml": []byte(`<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>value</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="1"><v>0.25</v></c><c r="C2" t="b"><v>0</v></c><c r="D2" t="e"><v>#DIV/0!</v></c></row><row r="3"><c r="A3"><f>1+1</f><v>2</v></c><c r="B3"><f t="shared" si="0"/><v>0</v></c><c r="C3"><f>TODAY()</f></c></row><row r="1000"><c r="XFD1000" s="1"/></row></sheetData></worksheet>`),
	}
	input := workbookZIP(t, entries)
	sheets, metrics, err := readNativeWorkbook(input, sheetSelection{Mode: "first"})
	if err != nil {
		t.Fatal(err)
	}
	if len(metrics) != 3 || len(sheets) != 1 {
		t.Fatal(metrics, sheets)
	}
	expected := [][]string{{"id", "value"}, {"hello世界", "25.0%", "FALSE", "#DIV/0!"}, {"2", "0"}}
	if !reflect.DeepEqual(sheets[0].Values, expected) {
		t.Fatalf("values: %#v", sheets[0].Values)
	}
	if sheets[0].Metadata[2][2].Type != "empty" || sheets[0].Metadata[2][2].Raw != nil {
		t.Fatal("missing formula cache", sheets[0].Metadata)
	}
	entries["bad.xml"] = []byte(`<!DOCTYPE foo><foo/>`)
	if _, _, err = readNativeWorkbook(workbookZIP(t, entries), sheetSelection{Mode: "first"}); err == nil || !strings.Contains(err.Error(), "DTD") {
		t.Fatal("DTD accepted", err)
	}
}

func TestNativeXLSXEmptySidesUTF16AndEscapes(t *testing.T) {
	got, _, err := readNativeWorkbook(nil, sheetSelection{Mode: "first"})
	if err != nil || got == nil || len(got) != 0 {
		t.Fatal("empty side", got, err)
	}
	for _, big := range []bool{false, true} {
		entries := map[string][]byte{
			"xl/workbook.xml":          []byte(`<workbook/>`),
			"xl/sharedStrings.xml":     []byte(`<sst><si><t>_x0041_&amp;_xD83D__xDE00_</t></si><si><r><t>_x00</t></r><r><t>41_</t></r></si></sst>`),
			"xl/worksheets/sheet1.xml": utf16XML(`<?xml version="1.0" encoding="UTF-16"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v/></c></row></sheetData></worksheet>`, big),
		}
		got, _, err = readNativeWorkbook(workbookZIP(t, entries), sheetSelection{Mode: "first"})
		if err != nil || !reflect.DeepEqual(got[0].Values, [][]string{{"A&😀", "_x0041_"}}) {
			t.Fatal(got, err)
		}
		entries["xl/worksheets/orphan.xml"] = []byte(`<worksheet><broken>`)
		if _, _, err = readNativeWorkbook(workbookZIP(t, entries), sheetSelection{Mode: "all"}); err == nil {
			t.Fatal("all mode skipped invalid orphan worksheet")
		}
	}
}

func TestNativeXLSXCDATAKeepsPluginCellSemantics(t *testing.T) {
	sheet := `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>before<![CDATA[ignored]]>after</t></is></c><c r="C1" t="s"><v>0</v></c><c r="D1"><v>1<![CDATA[99]]>2</v></c></row><row r="2"><c r="A2"><f><![CDATA[1+1]]></f><v>2</v></c><c r="B2"><f><![CDATA[1+1]]></f></c><c r="C2"><f>1<![CDATA[+9]]>+1</f><v>2</v></c><c r="D2"><f>1+1</f><v><![CDATA[2]]></v></c><c r="E2" t="inlineStr"><is><t><![CDATA[ignored]]></t></is></c><c r="F2" t="s"><v>1</v></c></row><row r="3"><c r="A3"><v><![CDATA[5]]></v></c><c r="B3" t="inlineStr"><is><r><t><![CDATA[ignored]]></t></r></is></c></row><row r="1000"><c r="XFD1000"><f><![CDATA[1+1]]></f></c></row></sheetData></worksheet>`
	for _, encoded := range [][]byte{[]byte(sheet), utf16XML(sheet, false), utf16XML(sheet, true)} {
		input := workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`), "xl/sharedStrings.xml": []byte(`<sst><si><t>ordinary<![CDATA[ignored]]>text</t></si><si><t><![CDATA[ignored]]></t></si></sst>`), "xl/worksheets/sheet1.xml": encoded})
		got, _, err := readNativeWorkbook(input, sheetSelection{Mode: "first"})
		if err != nil {
			t.Fatal(err)
		}
		want := [][]string{{"id", "beforeafter", "ordinarytext", "12"}, {"2", "", "2"}, {}}
		if !reflect.DeepEqual(got[0].Values, want) {
			t.Fatalf("CDATA values %#v", got[0].Values)
		}
		if got[0].Metadata[1][3] != (cellMetadata{Type: "empty"}) || got[0].Metadata[2][1] != (cellMetadata{Type: "string", Raw: ""}) {
			t.Fatal(got[0].Metadata)
		}
	}
}

type nativeSmallReads struct{ source *strings.Reader }

func (r nativeSmallReads) Read(p []byte) (int, error) {
	if len(p) > 1 {
		p = p[:1]
	}
	return r.source.Read(p)
}

func TestNativeXMLPrefixTrackingAcrossBoundaries(t *testing.T) {
	for _, padding := range []int{0, 1, 4080, 4095, 4096, 8200} {
		document := `<root>` + strings.Repeat(" ", padding) + `<![CDATA[` + strings.Repeat("x", 9000) + `]]>kept</root>`
		for _, small := range []bool{false, true} {
			var source io.Reader = strings.NewReader(document)
			if small {
				source = nativeSmallReads{strings.NewReader(document)}
			}
			var text strings.Builder
			rows, cells := 0, 0
			err := scanXMLTokens(source, false, &rows, &cells, func(token xml.Token) error {
				if value, ok := token.(xml.CharData); ok {
					text.Write(value)
				}
				return nil
			})
			if err != nil || text.String() != strings.Repeat(" ", padding)+"kept" {
				t.Fatalf("padding %d small %v: length %d error %v", padding, small, text.Len(), err)
			}
		}
	}
	rows, cells := 0, 0
	if err := scanXMLTokens(strings.NewReader(`<![CDATA[outside]]><root/>`), false, &rows, &cells, func(xml.Token) error { return nil }); err == nil {
		t.Fatal("visitor suppression bypassed XML root validation")
	}
}

func TestNativeXLSXSelectionSkipsOtherWorksheetPayloads(t *testing.T) {
	entries := map[string][]byte{
		"xl/workbook.xml":                     []byte(`<workbook xmlns="` + spreadsheetNS + `" xmlns:r="` + relationshipNS + `"><sheets><sheet name="Kept" r:id="b"/><sheet name="Ignored" r:id="a"/></sheets></workbook>`),
		"xl/_rels/workbook.xml.rels":          []byte(`<Relationships xmlns="` + packageRelationshipNS + `"><Relationship Id="a" Type="` + relationshipNS + `/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="b" Type="` + relationshipNS + `/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`),
		"xl/worksheets/sheet1.xml":            []byte(`<worksheet><broken>`),
		"xl/worksheets/_rels/sheet1.xml.rels": []byte(`<broken>`),
		"xl/worksheets/sheet2.xml":            []byte(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>kept</t></is></c></row></sheetData></worksheet>`),
	}
	input := workbookZIP(t, entries)
	for _, selection := range []sheetSelection{{Mode: "first"}, {Mode: "named", Names: []string{"Kept"}}} {
		sheets, _, err := readNativeWorkbook(input, selection)
		if err != nil || len(sheets) != 1 || sheets[0].Name != "Kept" || sheets[0].Values[0][0] != "kept" {
			t.Fatal(sheets, err)
		}
	}
	if _, _, err := readNativeWorkbook(input, sheetSelection{Mode: "all"}); err == nil {
		t.Fatal("invalid selected worksheet accepted")
	}
}

func TestNativeXLSXRejectsUnsafeAndOversizedValues(t *testing.T) {
	for _, cells := range []string{`<row r="1"><c r="A1"><v>9007199254740992</v></c></row>`, `<row r="1048576"><c r="XFD1048576"><v>1</v></c></row>`, `<row r="1"><c r="XFE1"><v>1</v></c></row>`} {
		input := workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`), "xl/worksheets/sheet1.xml": []byte(`<worksheet><sheetData>` + cells + `</sheetData></worksheet>`)})
		if _, _, err := readNativeWorkbook(input, sheetSelection{Mode: "first"}); err == nil {
			t.Fatal("invalid values accepted", cells)
		}
	}
}

// Optional cross-runtime fixture directory. Each XLSX sits next to JSON emitted
// by src/xlsx.js, enabling broad parity checks without a Node dependency in Go tests.
func TestNativeXLSXOracleFixtures(t *testing.T) {
	dir := os.Getenv("GRIDIFF_NATIVE_FIXTURES")
	if dir == "" {
		t.Skip("set GRIDIFF_NATIVE_FIXTURES to run Node reader oracle fixtures")
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.xlsx"))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		t.Run(filepath.Base(file), func(t *testing.T) {
			expectedData, err := os.ReadFile(strings.TrimSuffix(file, ".xlsx") + ".json")
			if err != nil {
				t.Fatal(err)
			}
			var expected []rawSheet
			if err = json.Unmarshal(expectedData, &expected); err != nil {
				t.Fatal(err)
			}
			input, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			actual, _, err := readNativeWorkbook(input, sheetSelection{Mode: "all"})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, expected) {
				for s := range actual {
					if s >= len(expected) {
						t.Errorf("extra sheet %s", actual[s].Name)
						continue
					}
					for r := range actual[s].Values {
						if r >= len(expected[s].Values) {
							t.Errorf("extra row %d", r+1)
							continue
						}
						for c := range actual[s].Values[r] {
							if c >= len(expected[s].Values[r]) || actual[s].Values[r][c] != expected[s].Values[r][c] {
								t.Errorf("sheet %s row %d col %d: actual %q expected row %q", actual[s].Name, r+1, c+1, actual[s].Values[r][c], expected[s].Values[r])
							}
						}
					}
					if !reflect.DeepEqual(actual[s].Metadata, expected[s].Metadata) {
						a, _ := json.Marshal(actual[s].Metadata)
						b, _ := json.Marshal(expected[s].Metadata)
						t.Errorf("metadata differs\nactual %s\nexpected %s", a, b)
					}
				}
				t.Fail()
			}
		})
	}
}
