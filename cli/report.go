package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type comparisonReport struct {
	SchemaVersion  int            `json:"schemaVersion"`
	Version        string         `json:"version"`
	Complete       bool           `json:"complete"`
	Sources        []string       `json:"sources"`
	SheetSelection sheetSelection `json:"sheetSelection"`
	SourceSheets   [][]string     `json:"sourceSheets,omitempty"`
	Options        tableOptions   `json:"options"`
	Counts         *diffCounts    `json:"counts,omitempty"`
	Error          string         `json:"error,omitempty"`
	Sheets         []reportSheet  `json:"sheets"`
}

type reportSheet struct {
	Name    string     `json:"name"`
	Status  string     `json:"status"`
	Skipped [2]int     `json:"skippedBlankRows"`
	Error   string     `json:"error,omitempty"`
	Result  *diffModel `json:"result,omitempty"`
}

func writeComparisonReport(files []string, selection sheetSelection, options tableOptions, output string) error {
	output, err := filepath.Abs(output)
	if err != nil {
		return err
	}
	outputInfo, statErr := os.Stat(output)
	if statErr != nil && !os.IsNotExist(statErr) {
		return statErr
	}
	for _, file := range files {
		inputInfo, _ := os.Stat(file)
		if output == file || outputInfo != nil && inputInfo != nil && os.SameFile(outputInfo, inputInfo) {
			return errors.New("报告不能覆盖输入文件")
		}
	}
	report := comparisonReport{SchemaVersion: 1, Version: version, Sources: files, SheetSelection: selection, Options: options, Sheets: []reportSheet{}}
	data, failure := makeSnapshot(files, selection)
	if failure == nil && data.Error != "" {
		failure = errors.New(data.Error)
	}
	if failure == nil {
		if data.XLSX {
			report.SourceSheets = make([][]string, 2)
			for side, book := range data.native.books {
				report.SourceSheets[side] = []string{}
				for _, sheet := range book {
					report.SourceSheets[side] = append(report.SourceSheets[side], sheet.Name)
				}
			}
		}
		var sheets []*nativeSheet
		sheets, failure = data.native.prepare(data, &nativeSettings{Options: options})
		counts := diffCounts{}
		for _, sheet := range sheets {
			entry := reportSheet{Name: sheet.name, Status: sheet.status, Error: sheet.failure}
			for side, table := range sheet.tables {
				if table != nil {
					entry.Skipped[side] = table.SkippedBlankRows
				}
			}
			if sheet.failure != "" {
				failure = errors.Join(failure, fmt.Errorf("工作表「%s」：%s", sheet.name, sheet.failure))
			} else {
				result := *sheet.result
				result.Rows = append([]diffRow{}, result.Rows...)
				for i := range result.Rows {
					// Internal match keys may contain entire unkeyed records.
					result.Rows[i].Key = ""
				}
				entry.Result = &result
				counts.Added += result.Counts.Added
				counts.Removed += result.Counts.Removed
				counts.Modified += result.Counts.Modified
				counts.Unchanged += result.Counts.Unchanged
				counts.Moved += result.Counts.Moved
				counts.Cells += result.Counts.Cells
				counts.Schema += result.Counts.Schema
			}
			report.Sheets = append(report.Sheets, entry)
		}
		if failure == nil {
			report.Complete = true
			report.Counts = &counts
		}
	}
	if failure != nil {
		report.Error = failure.Error()
	}
	temporary, err := os.CreateTemp(filepath.Dir(output), ".gridiff-report-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	encoder := json.NewEncoder(temporary)
	encoder.SetIndent("", "  ")
	err = encoder.Encode(report)
	closeErr := temporary.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(temporary.Name(), output); err != nil {
		return err
	}
	return failure
}
