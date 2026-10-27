package main

import (
	"bytes"
	"reflect"
	"testing"
)

func firstSheetFixture() map[string][]byte {
	return map[string][]byte{
		"xl/workbook.xml":                     []byte(`<workbook xmlns="` + spreadsheetNS + `" xmlns:r="` + relationshipNS + `"><bookViews><workbookView activeTab="1"/></bookViews><sheets><sheet name="Hidden first" state="hidden" sheetId="7" r:id="chosen"/><sheet name="Other" sheetId="1" r:id="other"/></sheets></workbook>`),
		"xl/_rels/workbook.xml.rels":          []byte(`<Relationships xmlns="` + packageRelationshipNS + `"><Relationship Id="other" Type="` + relationshipNS + `/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="chosen" Type="` + relationshipNS + `/worksheet" Target="/xl/worksheets/sheet7.xml"/></Relationships>`),
		"xl/worksheets/sheet7.xml":            []byte(`<worksheet><sheetData><row r="1"><c r="A1"><f>Other!A1</f><v>42</v></c><c r="B1" t="s"><v>0</v></c><c r="C1" s="1"><v>0.25</v></c></row></sheetData></worksheet>`),
		"xl/worksheets/_rels/sheet7.xml.rels": []byte(`<Relationships/>`),
		"xl/worksheets/sheet1.xml":            []byte(`invalid XML that must never be parsed`),
		"xl/worksheets/_rels/sheet1.xml.rels": []byte(`invalid relationships that must never be parsed`),
		"xl/sharedStrings.xml":                []byte(`<sst><si><t>共享文本</t></si></sst>`),
		"xl/styles.xml":                       []byte(`<styleSheet><numFmts><numFmt numFmtId="164" formatCode="0.0%"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`),
	}
}

func TestFirstWorksheetSkipsLaterPayloadsAndPreservesSharedParts(t *testing.T) {
	for _, utf16 := range []bool{false, true} {
		parts := firstSheetFixture()
		if utf16 {
			parts["xl/workbook.xml"] = utf16XML(string(parts["xl/workbook.xml"]), true)
		}
		original := workbookZIP(t, parts)
		sheets, _, err := readNativeWorkbook(original, sheetSelection{})
		if err != nil {
			t.Fatal(err)
		}
		if len(sheets) != 1 || sheets[0].Name != "Hidden first" {
			t.Fatalf("wrong worksheet selected: %+v", sheets)
		}
		if !reflect.DeepEqual(sheets[0].Values, [][]string{{"42", "共享文本", "25.0%"}}) {
			t.Fatal("cached value/shared strings/styles lost", sheets[0].Values)
		}
		if !reflect.DeepEqual(sheets[0].Metadata[0], []cellMetadata{{Type: "number", Raw: 42.0}, {Type: "string", Raw: "共享文本"}, {Type: "number", Raw: 0.25}}) {
			t.Fatal("raw cached-value metadata changed", sheets[0].Metadata)
		}
	}
}

func TestFirstWorksheetStillRejectsInvalidSelectedDataAndRelationships(t *testing.T) {
	for _, change := range []func(map[string][]byte){
		func(p map[string][]byte) { p["xl/worksheets/sheet7.xml"] = []byte(`<worksheet><broken></worksheet>`) },
		func(p map[string][]byte) { p["xl/worksheets/_rels/sheet7.xml.rels"] = []byte(`<broken>`) },
		func(p map[string][]byte) { delete(p, "xl/worksheets/sheet7.xml") },
		func(p map[string][]byte) { delete(p, "xl/_rels/workbook.xml.rels") },
		func(p map[string][]byte) {
			p["xl/workbook.xml"] = bytes.Replace(p["xl/workbook.xml"], []byte(`r:id="chosen"`), []byte(`r:id="missing"`), 1)
		},
		func(p map[string][]byte) {
			p["xl/_rels/workbook.xml.rels"] = bytes.Replace(p["xl/_rels/workbook.xml.rels"], []byte(`Id="chosen"`), []byte(`Id="other"`), 1)
		},
		func(p map[string][]byte) {
			p["xl/_rels/workbook.xml.rels"] = bytes.Replace(p["xl/_rels/workbook.xml.rels"], []byte(`Target="/xl/worksheets/sheet7.xml"`), []byte(`TargetMode="External" Target="https://example.com/sheet.xml"`), 1)
		},
	} {
		parts := firstSheetFixture()
		change(parts)
		if _, _, err := readNativeWorkbook(workbookZIP(t, parts), sheetSelection{}); err == nil {
			t.Fatal("invalid first sheet accepted")
		}
	}
}

func TestFirstWorksheetAcceptsStrictAndInternalRelationships(t *testing.T) {
	for _, strict := range []bool{false, true} {
		parts := firstSheetFixture()
		parts["xl/_rels/workbook.xml.rels"] = bytes.ReplaceAll(parts["xl/_rels/workbook.xml.rels"], []byte(` Target=`), []byte(` TargetMode="Internal" Target=`))
		if strict {
			for _, name := range []string{"xl/workbook.xml", "xl/_rels/workbook.xml.rels"} {
				parts[name] = bytes.ReplaceAll(parts[name], []byte(spreadsheetNS), []byte(strictSpreadsheetNS))
				parts[name] = bytes.ReplaceAll(parts[name], []byte(relationshipNS), []byte(strictRelationshipNS))
			}
		}
		if _, _, err := readNativeWorkbook(workbookZIP(t, parts), sheetSelection{}); err != nil {
			t.Fatal(err)
		}
	}
	parts := firstSheetFixture()
	parts["xl/workbook.xml"] = bytes.Replace(parts["xl/workbook.xml"], []byte(`<sheet name=`), []byte(`<sheet xmlns="urn:unknown" name=`), 1)
	if _, _, err := readNativeWorkbook(workbookZIP(t, parts), sheetSelection{}); err == nil {
		t.Fatal("unknown first sheet namespace skipped")
	}
}

func TestArchiveConfigurableWorksheetSelection(t *testing.T) {
	parts := firstSheetFixture()
	valid := []byte(`<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`)
	parts["xl/worksheets/sheet1.xml"] = valid
	parts["xl/worksheets/_rels/sheet1.xml.rels"] = []byte(`<Relationships/>`)
	original := workbookZIP(t, parts)
	for _, item := range []struct {
		selection sheetSelection
		names     []string
	}{
		{sheetSelection{}, []string{"Hidden first"}},
		{sheetSelection{Mode: "all"}, []string{"Hidden first", "Other"}},
		{sheetSelection{Mode: "named", Names: []string{"Other"}}, []string{"Other"}},
		{sheetSelection{Mode: "named", Names: []string{"Other", "Hidden first", "Other"}}, []string{"Hidden first", "Other"}},
		{sheetSelection{Mode: "named", Names: []string{"missing"}}, []string{}},
	} {
		sheets, _, err := readNativeWorkbook(original, item.selection)
		if err != nil {
			t.Fatal(err)
		}
		names := make([]string, len(sheets))
		for i, sheet := range sheets {
			names[i] = sheet.Name
		}
		if !reflect.DeepEqual(names, item.names) {
			t.Fatalf("selection %+v: %v, want %v", item.selection, names, item.names)
		}
	}
	bad := workbookZIP(t, firstSheetFixture())
	if _, _, err := readNativeWorkbook(bad, sheetSelection{Mode: "named", Names: []string{"Hidden first"}}); err != nil {
		t.Fatal(err)
	}
	for _, selection := range []sheetSelection{{Mode: "all"}, {Mode: "named", Names: []string{"Other"}}} {
		if _, _, err := readNativeWorkbook(bad, selection); err == nil {
			t.Fatal("selected damaged sheet accepted", selection)
		}
	}
	parts["xl/workbook.xml"] = append([]byte(`<!DOCTYPE workbook>`), parts["xl/workbook.xml"]...)
	if _, _, err := readNativeWorkbook(workbookZIP(t, parts), sheetSelection{Mode: "all"}); err == nil {
		t.Fatal("all mode skipped metadata validation")
	}
}
