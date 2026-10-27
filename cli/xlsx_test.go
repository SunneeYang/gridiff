package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
	"unicode/utf16"
)

// All archive safety tests use the production native reader.
func validateArchive(data []byte) error {
	_, _, err := readNativeWorkbook(data, sheetSelection{Mode: "all"})
	return err
}

func workbookZIP(t *testing.T, entries map[string][]byte) []byte {
	t.Helper()
	if string(entries["xl/workbook.xml"]) == `<workbook/>` && entries["xl/worksheets/sheet1.xml"] != nil {
		entries["xl/workbook.xml"] = []byte(`<workbook xmlns="` + spreadsheetNS + `" xmlns:r="` + relationshipNS + `"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`)
		entries["xl/_rels/workbook.xml.rels"] = []byte(`<Relationships xmlns="` + packageRelationshipNS + `"><Relationship Id="rId1" Type="` + relationshipNS + `/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
	}
	var out bytes.Buffer
	w := zip.NewWriter(&out)
	for name, data := range entries {
		writer, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func utf16XML(text string, big bool) []byte {
	var order binary.ByteOrder = binary.LittleEndian
	data := []byte{0xff, 0xfe}
	if big {
		order = binary.BigEndian
		data = []byte{0xfe, 0xff}
	}
	for _, unit := range utf16.Encode([]rune(text)) {
		var pair [2]byte
		order.PutUint16(pair[:], unit)
		data = append(data, pair[:]...)
	}
	return data
}

func TestArchiveAllowsUTF8AndUTF16CustomXML(t *testing.T) {
	for _, data := range [][]byte{[]byte(`<?xml version="1.0" encoding="UTF-8"?><custom>你好😀</custom>`), []byte("\ufeff<custom/>"), utf16XML(`<?xml version="1.0" encoding="UTF-16"?><custom>你好😀</custom>`, false), utf16XML(`<?xml version="1.0" encoding="UTF-16"?><custom>你好😀</custom>`, true)} {
		archive := workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`), "customXml/item1.xml": data, "xl/worksheets/sheet1.xml": []byte(`<worksheet><row r="1"><c r="A1"/></row></worksheet>`)})
		if err := validateArchive(archive); err != nil {
			t.Fatal(err)
		}
	}
}

func TestArchiveRejectsDTDInvalidEncodingAndCellCoordinates(t *testing.T) {
	for _, data := range [][]byte{[]byte(`<!DOCTYPE x><custom/>`), utf16XML(`<!DOCTYPE x><custom/>`, false), utf16XML(`<!DOCTYPE x><custom/>`, true), append(utf16XML(`<custom/>`, false), 0), []byte{0xff, 0xfe, 0x00, 0xd8}, []byte(`<a/><b/>`), []byte(`<?xml version="1.0" encoding="ISO-8859-1"?><custom/>`)} {
		if err := validateArchive(workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`), "customXml/item1.xml": data})); err == nil {
			t.Fatalf("accepted bad XML: %x", data)
		}
	}
	for _, sheet := range []string{`<sheet><row r="0"/></sheet>`, `<sheet><row r="1"><c r="A2"/></row></sheet>`, `<sheet><row r="1"><c r="XFE1"/></row></sheet>`, `<sheet><row r="1048577"/></sheet>`} {
		if err := validateArchive(workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`), "xl/worksheets/sheet1.xml": []byte(sheet)})); err == nil {
			t.Fatal("accepted invalid sheet", sheet)
		}
	}
	rows, cells := maxCells, 0
	if err := scanXMLTokens(strings.NewReader(`<sheet><row r="1"/></sheet>`), true, &rows, &cells, nil); err == nil {
		t.Fatal("row budget not enforced")
	}
	rows, cells = 0, maxCells
	if err := scanXMLTokens(strings.NewReader(`<sheet><row r="1"><c r="A1"/></row></sheet>`), true, &rows, &cells, nil); err == nil {
		t.Fatal("cell budget not enforced")
	}
	// Formula expressions are not evaluated or retained, but their XML remains validated.
	for _, formula := range []string{`A1 &unknown; B1`, `A1</invalid>`, `<!DOCTYPE bad>`} {
		worksheet := `<worksheet><sheetData><row r="1"><c r="A1"><f>` + formula + `</f><v>1</v></c></row></sheetData></worksheet>`
		if err := validateArchive(workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`), "xl/worksheets/sheet1.xml": []byte(worksheet)})); err == nil {
			t.Fatal("invalid discarded formula XML accepted", formula)
		}
	}
}

func TestNativeArchiveRejectsUnsafePathsAndEncryption(t *testing.T) {
	for _, name := range []string{"xl/worksheets/./sheet1.xml", "../escaped.xml", "/absolute.xml", `xl\worksheets\sheet1.xml`, "C:/drive.xml"} {
		input := workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`), name: []byte(`<worksheet/>`)})
		if _, _, err := readNativeWorkbook(input, sheetSelection{Mode: "first"}); err == nil || !strings.Contains(err.Error(), "路径") {
			t.Fatal("unsafe ZIP path accepted", name, err)
		}
	}
	input := workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`)})
	central := bytes.Index(input, []byte{'P', 'K', 1, 2})
	binary.LittleEndian.PutUint16(input[central+8:central+10], binary.LittleEndian.Uint16(input[central+8:central+10])|1)
	if err := validateArchive(input); err == nil || !strings.Contains(err.Error(), "加密") {
		t.Fatal("encrypted ZIP accepted", err)
	}
}

func TestArchiveRejectsDuplicateMissingWorkbookAndExpansion(t *testing.T) {
	var out bytes.Buffer
	w := zip.NewWriter(&out)
	for i := 0; i < 2; i++ {
		part, err := w.Create("xl/workbook.xml")
		if err != nil {
			t.Fatal(err)
		}
		part.Write([]byte(`<workbook/>`))
	}
	w.Close()
	if err := validateArchive(out.Bytes()); err == nil || !strings.Contains(err.Error(), "重复") {
		t.Fatal(err)
	}
	if err := validateArchive(workbookZIP(t, map[string][]byte{"unrelated.xml": []byte(`<x/>`)})); err == nil {
		t.Fatal("missing workbook accepted")
	}
	data := workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`)})
	central := bytes.Index(data, []byte{'P', 'K', 1, 2})
	binary.LittleEndian.PutUint32(data[central+24:central+28], maxExpanded+1)
	if err := validateArchive(data); err == nil || !strings.Contains(err.Error(), "128 MiB") {
		t.Fatal("declared expansion budget missing", err)
	}
}

func TestArchiveAllowsExpandedXMLAbove64MiB(t *testing.T) {
	var out bytes.Buffer
	w := zip.NewWriter(&out)
	part, err := w.Create("xl/workbook.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write([]byte(`<workbook/>`)); err != nil {
		t.Fatal(err)
	}
	part, err = w.Create("customXml/item1.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write([]byte(`<data>`)); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte{'x'}, 64*1024)
	for i := 0; i < 1024; i++ {
		if _, err = part.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = part.Write([]byte(`</data>`)); err != nil {
		t.Fatal(err)
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	if err = validateArchive(out.Bytes()); err != nil {
		t.Fatal(err)
	}
}
