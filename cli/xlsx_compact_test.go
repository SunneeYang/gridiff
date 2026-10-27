package main

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestFormulaSnapshotPreservesCachesAndXML(t *testing.T) {
	const prefix = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">`
	const suffix = `</row></sheetData></worksheet>`
	formula := strings.Repeat(`SUM(A1:A20)+`, 2000)
	cells := `<c r="A1" s="4"><f t="shared" si="0" ref="A1:B1">` + formula + `</f><v>0</v></c>` +
		`<c r="B1"><f t="shared" si="0"/><v>2</v></c>` +
		`<c r="C1" t="b"><f>1=2</f><v>0</v></c>` +
		`<c r="D1" t="str"><f>""</f><v></v></c>` +
		`<c r="E1"><f>NOW()</f></c>` +
		`<c r="F1" t="e"><f>1/0</f><v>#DIV/0!</v></c>` +
		`<c r="G1" t="inlineStr"><is><t><![CDATA[literal <f>keep</f>]]></t></is></c>`
	input := prefix + cells + suffix
	var target formulaXML
	rows, count := 0, 0
	if err := scanXML(strings.NewReader(input), true, &rows, &count, &target); err != nil {
		t.Fatal(err)
	}
	expected := strings.NewReplacer(formula, "0", `>1=2<`, `>0<`, `>""<`, `>0<`, `>NOW()<`, `>0<`, `>1/0<`, `>0<`).Replace(input)
	if target.output.String() != expected {
		t.Fatal("formula compaction changed cached values, metadata, or literal XML")
	}
	if !target.changed || count != 7 || rows != 1 {
		t.Fatal("missing validation or compaction")
	}
	original := workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`), "xl/worksheets/sheet1.xml": []byte(input), "xl/styles.xml": []byte(`<styles/>`)})
	prepared, err := prepareArchive(original, true, sheetSelection{})
	if err != nil {
		t.Fatal(err)
	}
	if len(prepared) >= len(original) {
		t.Fatal("large formula snapshot was not reduced")
	}
	archive, err := zip.NewReader(bytes.NewReader(prepared), int64(len(prepared)))
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range archive.File {
		reader, err := part.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		if part.Name == "xl/worksheets/sheet1.xml" && string(content) != expected {
			t.Fatal("archive content differs")
		}
		if part.Name == "xl/styles.xml" && string(content) != `<styles/>` {
			t.Fatal("style part changed")
		}
	}
}

func TestFormulaSnapshotStillValidatesDiscardedTextAndOtherNamespaces(t *testing.T) {
	for _, formula := range []string{`A1 &unknown; B1`, `A1</invalid>`, `<!DOCTYPE bad>`} {
		input := `<worksheet><sheetData><row r="1"><c r="A1"><f>` + formula + `</f><v>1</v></c></row></sheetData></worksheet>`
		var target formulaXML
		rows, cells := 0, 0
		if err := scanXML(strings.NewReader(input), true, &rows, &cells, &target); err == nil {
			t.Fatal("invalid formula XML accepted")
		}
	}
	input := `<worksheet><sheetData><row r="1"><c r="A1"><f xmlns="urn:custom">keep this</f><v>1</v></c></row></sheetData></worksheet>`
	var target formulaXML
	rows, cells := 0, 0
	if err := scanXML(strings.NewReader(input), true, &rows, &cells, &target); err != nil {
		t.Fatal(err)
	}
	if target.changed || target.output.String() != input {
		t.Fatal("custom namespace was changed")
	}
}

func TestFormulaSnapshotRetainsUTF16AndUnchangedArchive(t *testing.T) {
	for _, part := range [][]byte{[]byte(`<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`), utf16XML(`<?xml version="1.0" encoding="UTF-16"?><worksheet><sheetData><row r="1"><c r="A1"><f>A1+1</f><v>1</v></c></row></sheetData></worksheet>`, false)} {
		original := workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`), "xl/worksheets/sheet1.xml": part})
		prepared, err := prepareArchive(original, true, sheetSelection{})
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(original, prepared) {
			t.Fatal("unchanged/UTF-16 archive rewritten")
		}
	}
}

func TestFormulaCDATAAndCompactionBufferFallback(t *testing.T) {
	for _, formula := range []string{`<![CDATA[A1+1]]>`, `<![CDATA[A1]]><![CDATA[+1]]>`, `<![CDATA[A1]]>+1`} {
		input := `<worksheet><sheetData><row r="1"><c r="A1"><f>` + formula + `</f></c></row></sheetData></worksheet>`
		var target formulaXML
		rows, cells := 0, 0
		if err := scanXML(strings.NewReader(input), true, &rows, &cells, &target); err != nil {
			t.Fatal(err)
		}
		expected := strings.Replace(input, `]]>+1`, `]]>0`, 1)
		if target.output.String() != expected {
			t.Fatal("CDATA semantics changed")
		}
	}
	var capture formulaCapture
	capture.Write(bytes.Repeat([]byte{'x'}, maxBytes))
	capture.Write([]byte("x"))
	if !capture.disabled || capture.Len() != 0 {
		t.Fatal("oversized token retained")
	}
	capture.Write([]byte("discard"))
	if capture.Len() != 0 {
		t.Fatal("fallback still captures")
	}
	input := `<worksheet><sheetData><row r="1"><c r="A1"><f>A1+1</f><v>1</v></c><c r="B1"><is><t>` + strings.Repeat("x", maxBytes) + `</t></is></c></row></sheetData></worksheet>`
	var target formulaXML
	rows, cells := 0, 0
	if err := scanXML(strings.NewReader(input), true, &rows, &cells, &target); err != nil {
		t.Fatal(err)
	}
	if target.changed || target.output.Len() != 0 {
		t.Fatal("large XML was retained for compaction")
	}
}
