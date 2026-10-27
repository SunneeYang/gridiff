package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
	"unicode/utf16"
)

func workbookZIP(t *testing.T, entries map[string][]byte) []byte {
	t.Helper()
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
	for _, data := range [][]byte{[]byte(`<!DOCTYPE x><custom/>`), utf16XML(`<!DOCTYPE x><custom/>`, false), utf16XML(`<!DOCTYPE x><custom/>`, true), append(utf16XML(`<custom/>`, false), 0), []byte{0xff, 0xfe, 0x00, 0xd8}, []byte(`<a/><b/>`)} {
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
	if err := validateXML(strings.NewReader(`<sheet><row r="1"/></sheet>`), true, &rows, &cells); err == nil {
		t.Fatal("row budget not enforced")
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
	if err := validateArchive(data); err == nil || !strings.Contains(err.Error(), "64 MiB") {
		t.Fatal("declared expansion budget missing", err)
	}
}
