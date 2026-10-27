package main

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"
)

func firstSheetFixture() map[string][]byte {
	return map[string][]byte{
		"xl/workbook.xml":                     []byte(`<workbook xmlns="` + spreadsheetNS + `" xmlns:r="` + relationshipNS + `"><bookViews><workbookView activeTab="1"/></bookViews><sheets><sheet name="Hidden first" state="hidden" sheetId="7" r:id="chosen"/><sheet name="Other" sheetId="1" r:id="other"/></sheets></workbook>`),
		"xl/_rels/workbook.xml.rels":          []byte(`<Relationships xmlns="` + packageRelationshipNS + `"><Relationship Id="other" Type="` + relationshipNS + `/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="chosen" Type="` + relationshipNS + `/worksheet" Target="/xl/worksheets/sheet7.xml"/></Relationships>`),
		"xl/worksheets/sheet7.xml":            []byte(`<worksheet><sheetData><row r="1"><c r="A1"><f>Other!A1</f><v>42</v></c></row></sheetData></worksheet>`),
		"xl/worksheets/_rels/sheet7.xml.rels": []byte(`<Relationships/>`),
		"xl/worksheets/sheet1.xml":            []byte(`invalid XML that must never be parsed`),
		"xl/worksheets/_rels/sheet1.xml.rels": []byte(`invalid relationships that must never be parsed`),
		"xl/sharedStrings.xml":                []byte(`<sst/>`),
		"xl/styles.xml":                       []byte(`<styleSheet/>`),
	}
}

func TestFirstWorksheetSkipsLaterPayloadsAndPreservesSharedParts(t *testing.T) {
	for _, utf16 := range []bool{false, true} {
		parts := firstSheetFixture()
		if utf16 {
			parts["xl/workbook.xml"] = utf16XML(string(parts["xl/workbook.xml"]), true)
		}
		original := workbookZIP(t, parts)
		prepared, err := prepareArchive(original, true, sheetSelection{})
		if err != nil {
			t.Fatal(err)
		}
		archive, err := zip.NewReader(bytes.NewReader(prepared), int64(len(prepared)))
		if err != nil {
			t.Fatal(err)
		}
		seen := make(map[string]bool)
		for _, part := range archive.File {
			if strings.Contains(part.Name, "sheet1.xml") {
				t.Fatal("unused sheet remained in the browser snapshot")
			}
			seen[part.Name] = true
			r, err := part.Open()
			if err != nil {
				t.Fatal(err)
			}
			content, err := io.ReadAll(r)
			r.Close()
			if err != nil {
				t.Fatal(err)
			}
			if part.Name == "xl/worksheets/sheet7.xml" {
				if !bytes.Contains(content, []byte(`<v>42</v>`)) {
					t.Fatal("cached formula value lost")
				}
			} else if !bytes.Equal(content, parts[part.Name]) {
				t.Fatal("shared metadata changed", part.Name)
			}
		}
		for _, name := range []string{"xl/worksheets/sheet7.xml", "xl/worksheets/_rels/sheet7.xml.rels", "xl/sharedStrings.xml", "xl/styles.xml"} {
			if !seen[name] {
				t.Fatal("required part missing", name)
			}
		}
	}
}

func TestFirstWorksheetStillRejectsInvalidSelectedDataAndRelationships(t *testing.T) {
	for _, change := range []func(map[string][]byte){
		func(p map[string][]byte) { p["xl/worksheets/sheet7.xml"] = []byte(`<worksheet><broken></worksheet>`) },
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
		if _, err := prepareArchive(workbookZIP(t, parts), true, sheetSelection{}); err == nil {
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
		if _, err := prepareArchive(workbookZIP(t, parts), true, sheetSelection{}); err != nil {
			t.Fatal(err)
		}
	}
	parts := firstSheetFixture()
	parts["xl/workbook.xml"] = bytes.Replace(parts["xl/workbook.xml"], []byte(`<sheet name=`), []byte(`<sheet xmlns="urn:unknown" name=`), 1)
	if _, err := prepareArchive(workbookZIP(t, parts), true, sheetSelection{}); err == nil {
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
		paths     []string
	}{
		{sheetSelection{}, []string{"xl/worksheets/sheet7.xml"}},
		{sheetSelection{Mode: "all"}, []string{"xl/worksheets/sheet7.xml", "xl/worksheets/sheet1.xml"}},
		{sheetSelection{Mode: "named", Names: []string{"Other"}}, []string{"xl/worksheets/sheet1.xml"}},
		{sheetSelection{Mode: "named", Names: []string{"Other", "Hidden first", "Other"}}, []string{"xl/worksheets/sheet7.xml", "xl/worksheets/sheet1.xml"}},
		{sheetSelection{Mode: "named", Names: []string{"missing"}}, nil},
	} {
		prepared, err := prepareArchive(original, true, item.selection)
		if err != nil {
			t.Fatal(err)
		}
		archive, err := zip.NewReader(bytes.NewReader(prepared), int64(len(prepared)))
		if err != nil {
			t.Fatal(err)
		}
		seen := make(map[string]bool)
		for _, part := range archive.File {
			if strings.HasPrefix(part.Name, "xl/worksheets/") && strings.HasSuffix(part.Name, ".xml") {
				seen[part.Name] = true
			}
		}
		if len(seen) != len(item.paths) {
			t.Fatalf("selection %+v: %v", item.selection, seen)
		}
		for _, name := range item.paths {
			if !seen[name] {
				t.Fatal("missing selected sheet", name)
			}
		}
	}
	bad := workbookZIP(t, firstSheetFixture())
	if _, err := prepareArchive(bad, true, sheetSelection{Mode: "named", Names: []string{"Hidden first"}}); err != nil {
		t.Fatal(err)
	}
	for _, selection := range []sheetSelection{{Mode: "all"}, {Mode: "named", Names: []string{"Other"}}} {
		if _, err := prepareArchive(bad, true, selection); err == nil {
			t.Fatal("selected damaged sheet accepted", selection)
		}
	}
	parts["xl/workbook.xml"] = append([]byte(`<!DOCTYPE workbook>`), parts["xl/workbook.xml"]...)
	if _, err := prepareArchive(workbookZIP(t, parts), true, sheetSelection{Mode: "all"}); err == nil {
		t.Fatal("all mode skipped metadata validation")
	}
}
