package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCLIReportContainsEveryRecordAndOldNewValue(t *testing.T) {
	var before, after strings.Builder
	before.WriteString("id,value\n")
	after.WriteString("id,value\n")
	for i := 0; i < 237; i++ {
		fmt.Fprintf(&before, "%03d,old\n", i)
		fmt.Fprintf(&after, "%03d,new\n", i)
	}
	files := fixture(t, []byte(before.String()), []byte(after.String()), "csv")
	output := filepath.Join(t.TempDir(), "完整 报告.json")
	if err := run(append([]string{"--output", output}, files...)); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	var report struct {
		SchemaVersion int
		Complete      bool
		Sources       []string
		Counts        map[string]int
		Sheets        []struct {
			Result struct {
				Rows []struct {
					Identity string
					Key      string
					Cells    []struct{ Before, After *string }
				}
			}
		}
	}
	if err := json.Unmarshal(data, &report); err != nil {
		t.Fatal(err)
	}
	if report.SchemaVersion != 1 || !report.Complete || report.Counts["modified"] != 237 || len(report.Sheets) != 1 || len(report.Sheets[0].Result.Rows) != 237 {
		t.Fatalf("report is incomplete: %s", data)
	}
	last := report.Sheets[0].Result.Rows[236]
	if last.Identity != "236" || last.Key != "" || len(last.Cells) != 2 || last.Cells[1].Before == nil || *last.Cells[1].Before != "old" || last.Cells[1].After == nil || *last.Cells[1].After != "new" {
		t.Fatalf("last record lost its old/new values: %+v", last)
	}
	if len(report.Sources) != 2 || report.Sources[0] != files[0] || report.Sources[1] != files[1] {
		t.Fatalf("report changed old/new direction: %v", report.Sources)
	}
}

func TestCLIReportAcceptsCompositeKeysAndCustomHeaders(t *testing.T) {
	files := fixture(t, []byte("说明,说明,说明\nid,locale,value\n1,zh,旧\n1,en,old\n"), []byte("说明,说明,说明\nid,locale,value\n1,zh,新\n1,en,old\n"), "csv")
	output := filepath.Join(t.TempDir(), "report.json")
	args := []string{"--output", output, "--format", "custom", "--header-row", "2", "--data-start-row", "3", "--key", "id", "--key", "locale"}
	if err := run(append(args, files...)); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	var report struct {
		Complete bool
		Counts   map[string]int
		Options  map[string]any
		Sheets   []struct {
			Result struct{ Keys, Formats []string }
		}
	}
	if err := json.Unmarshal(data, &report); err != nil {
		t.Fatal(err)
	}
	if !report.Complete || report.Counts["modified"] != 1 || report.Counts["unchanged"] != 1 || strings.Join(report.Sheets[0].Result.Keys, ",") != "id,locale" || report.Options["headerRow"] != float64(2) {
		t.Fatalf("custom comparison parameters were ignored: %s", data)
	}
}

func TestCLIReportWorksheetScopeAndCachedValues(t *testing.T) {
	workbook := func(first, other string) []byte {
		parts := firstSheetFixture()
		sheet := func(value string) []byte {
			return []byte(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>001</t></is></c><c r="B2"><f>1+1</f><v>` + value + `</v></c></row></sheetData></worksheet>`)
		}
		parts["xl/worksheets/sheet7.xml"] = sheet(first)
		parts["xl/worksheets/sheet1.xml"] = sheet(other)
		parts["xl/worksheets/_rels/sheet1.xml.rels"] = []byte(`<Relationships/>`)
		return workbookZIP(t, parts)
	}
	files := fixture(t, workbook("120", "380"), workbook("150", "400"), "xlsx")
	for _, item := range []struct {
		name  string
		args  []string
		count int
	}{
		{"default-first", nil, 1},
		{"all", []string{"--sheets", "all"}, 2},
		{"named", []string{"--sheet", "Other"}, 1},
	} {
		t.Run(item.name, func(t *testing.T) {
			output := filepath.Join(t.TempDir(), "report.json")
			args := append([]string{"--output", output}, item.args...)
			if err := run(append(args, files...)); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(output)
			if err != nil {
				t.Fatal(err)
			}
			var report struct {
				Complete     bool
				Counts       map[string]int
				SourceSheets [][]string
				Sheets       []struct{ Name string }
			}
			if err := json.Unmarshal(data, &report); err != nil {
				t.Fatal(err)
			}
			if !report.Complete || len(report.Sheets) != item.count || report.Counts["modified"] != item.count || len(report.SourceSheets[0]) != item.count {
				t.Fatalf("wrong worksheet scope: %s", data)
			}
			if item.name == "default-first" && (report.Sheets[0].Name != "Hidden first" || !bytes.Contains(data, []byte(`"raw": 150`)) || bytes.Contains(data, []byte(`1+1`))) {
				t.Fatalf("first sheet or formula cache changed: %s", data)
			}
		})
	}
}

func TestCLIReportFailuresAreExplicitAndInputsStayUntouched(t *testing.T) {
	for _, item := range []struct {
		name, before, after string
	}{
		{"duplicate-key", "id,value\n1,a\n1,b", "id,value\n1,c"},
		{"invalid-csv", "id,value\n1,a", "id,value\n1,\"broken"},
	} {
		t.Run(item.name, func(t *testing.T) {
			files := fixture(t, []byte(item.before), []byte(item.after), "csv")
			output := filepath.Join(t.TempDir(), "report.json")
			if err := os.WriteFile(output, []byte(`{"complete":true}`), 0600); err != nil {
				t.Fatal(err)
			}
			if err := run(append([]string{"--output", output}, files...)); err == nil {
				t.Fatal("failed comparison returned success")
			}
			data, err := os.ReadFile(output)
			if err != nil {
				t.Fatal(err)
			}
			var report struct {
				Complete bool
				Error    string
				Counts   json.RawMessage
			}
			if err := json.Unmarshal(data, &report); err != nil || report.Complete || report.Error == "" || len(report.Counts) != 0 {
				t.Fatalf("failure looks like a complete/unchanged comparison: %s (%v)", data, err)
			}
			for i, expected := range []string{item.before, item.after} {
				data, err := os.ReadFile(files[i])
				if err != nil || string(data) != expected {
					t.Fatalf("input changed: %v", err)
				}
			}
		})
	}
}

func TestCLIReportRejectsInputAliasesAndBadOutputPaths(t *testing.T) {
	files := fixture(t, []byte("id,value\n1,old"), []byte("id,value\n1,new"), "csv")
	alias := filepath.Join(filepath.Dir(files[0]), "alias.json")
	if err := os.Link(files[0], alias); err != nil {
		t.Fatal(err)
	}
	for _, output := range []string{files[0], files[1], alias, filepath.Join(t.TempDir(), "missing", "report.json")} {
		if err := run(append([]string{"--output", output}, files...)); err == nil {
			t.Fatalf("unsafe/unwritable output accepted: %s", output)
		}
	}
	data, err := os.ReadFile(files[0])
	if err != nil || string(data) != "id,value\n1,old" {
		t.Fatal("output damaged the input", err)
	}
}

func TestCLIReportValidatesOptionsAndCanAlignByPosition(t *testing.T) {
	files := fixture(t, []byte("same,old\nsame,other"), []byte("same,new\nsame,other"), "csv")
	output := filepath.Join(t.TempDir(), "report.json")
	for _, args := range [][]string{
		{"--output"},
		{"--output", output, "--wait"},
		{"--output", output, "--format", "unknown"},
		{"--output", output, "--header-row", "zero"},
		{"--output", output, "--header-row", "0"},
		{"--output", output, "--alignment", "guess"},
		{"--format", "csv"},
	} {
		if err := run(append(append([]string{}, args...), files...)); err == nil {
			t.Fatalf("invalid parameters accepted: %v", args)
		}
	}
	args := []string{"diff", "--output", output, "--format", "headerless", "--alignment", "position"}
	if err := run(append(args, files...)); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	var report struct {
		Complete bool
		Counts   map[string]int
		Sheets   []struct{ Result struct{ Alignment string } }
	}
	if err := json.Unmarshal(data, &report); err != nil || !report.Complete || report.Counts["modified"] != 1 || report.Sheets[0].Result.Alignment != "position" {
		t.Fatalf("positional alignment failed: %s (%v)", data, err)
	}
}

func TestCLIReportUnchangedAndWholeFileAdditionDeletion(t *testing.T) {
	files := fixture(t, []byte("id,value\n001,same"), []byte("id,value\n001,same"), "csv")
	for _, item := range []struct {
		inputs []string
		status string
	}{
		{files, "unchanged"},
		{[]string{os.DevNull, files[1]}, "added"},
		{[]string{files[0], os.DevNull}, "removed"},
	} {
		output := filepath.Join(t.TempDir(), "report.json")
		if err := run(append([]string{"--output", output}, item.inputs...)); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(output)
		if err != nil {
			t.Fatal(err)
		}
		var report struct {
			Complete bool
			Counts   map[string]int
		}
		if err := json.Unmarshal(data, &report); err != nil || !report.Complete || report.Counts[item.status] != 1 {
			t.Fatalf("wrong empty-side/unchanged result: %s (%v)", data, err)
		}
	}
}
