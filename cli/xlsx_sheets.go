package main

import (
	"archive/zip"
	"encoding/xml"
	"errors"
	"io"
	"path"
	"strings"
)

const spreadsheetNS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const relationshipNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const packageRelationshipNS = "http://schemas.openxmlformats.org/package/2006/relationships"
const strictSpreadsheetNS = "http://purl.oclc.org/ooxml/spreadsheetml/main"
const strictRelationshipNS = "http://purl.oclc.org/ooxml/officeDocument/relationships"

// Workbook order, including hidden sheets, is independent of ZIP order and sheet filenames.
func worksheetPaths(entries map[string]*zip.File, expanded *int64, selection sheetSelection) (map[string]bool, error) {
	if selection.Mode == "all" {
		return nil, nil
	}
	selectedIDs := make(map[string]bool)
	selected := make(map[string]bool)
	wanted := make(map[string]bool)
	for _, name := range selection.Names {
		wanted[name] = true
	}
	sheetIndex := 0
	var stack []xml.Name
	read := func(name string, visit func(xml.Token) error) error {
		entry := entries[name]
		if entry == nil {
			return errors.New("XLSX 缺少工作簿或工作表关系信息")
		}
		reader, err := entry.Open()
		if err != nil {
			return err
		}
		limit := &io.LimitedReader{R: reader, N: maxExpanded - *expanded + 1}
		before := limit.N
		rows, cells := 0, 0
		err = scanXMLTokens(limit, false, &rows, &cells, nil, visit)
		*expanded += before - limit.N
		closeErr := reader.Close()
		if *expanded > maxExpanded {
			return errors.New("XLSX 解压后超过 128 MiB，请缩小工作簿")
		}
		if err != nil {
			return err
		}
		return closeErr
	}
	err := read("xl/workbook.xml", func(token xml.Token) error {
		switch value := token.(type) {
		case xml.StartElement:
			if len(stack) == 0 && (value.Name.Local != "workbook" || value.Name.Space != spreadsheetNS && value.Name.Space != strictSpreadsheetNS && value.Name.Space != "") {
				return errors.New("XLSX 工作簿命名空间无效或不受支持")
			}
			if len(stack) == 2 && stack[1].Local == "sheets" && value.Name.Local == "sheet" {
				name, id := "", ""
				for _, attr := range value.Attr {
					if attr.Name.Local == "name" && attr.Name.Space == "" {
						name = attr.Value
					}
					if attr.Name.Local == "id" && (attr.Name.Space == relationshipNS || attr.Name.Space == strictRelationshipNS) {
						id = attr.Value
					}
				}
				choose := wanted[name]
				if selection.Mode == "first" {
					choose = sheetIndex == 0
				}
				sheetIndex++
				if !choose {
					stack = append(stack, value.Name)
					return nil
				}
				if value.Name.Space != stack[0].Space || stack[1].Space != stack[0].Space {
					return errors.New("XLSX 所选工作表命名空间无效")
				}
				if id == "" {
					return errors.New("XLSX 所选工作表缺少关系标识")
				}
				if _, exists := selectedIDs[id]; exists {
					return errors.New("XLSX 所选工作表关系标识重复")
				}
				selectedIDs[id] = false
			}
			stack = append(stack, value.Name)
		case xml.EndElement:
			stack = stack[:len(stack)-1]
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(selectedIDs) == 0 && entries["xl/_rels/workbook.xml.rels"] == nil {
		return selected, nil
	}
	ids := make(map[string]bool)
	err = read("xl/_rels/workbook.xml.rels", func(token xml.Token) error {
		switch value := token.(type) {
		case xml.StartElement:
			if len(stack) == 1 && stack[0] == (xml.Name{Space: packageRelationshipNS, Local: "Relationships"}) && value.Name == (xml.Name{Space: packageRelationshipNS, Local: "Relationship"}) {
				attrs := make(map[string]string)
				for _, attr := range value.Attr {
					if attr.Name.Space == "" {
						attrs[attr.Name.Local] = attr.Value
					}
				}
				id := attrs["Id"]
				if id == "" || ids[id] {
					return errors.New("XLSX 工作表关系标识无效或重复")
				}
				ids[id] = true
				if _, wanted := selectedIDs[id]; wanted {
					target := attrs["Target"]
					if (attrs["Type"] != relationshipNS+"/worksheet" && attrs["Type"] != strictRelationshipNS+"/worksheet") || (attrs["TargetMode"] != "" && attrs["TargetMode"] != "Internal") || target == "" || strings.ContainsAny(target, "\\?#:") || path.Clean(target) != target || strings.HasPrefix(target, "../") {
						return errors.New("XLSX 所选工作表关系无效")
					}
					selectedPath := strings.TrimPrefix(target, "/")
					if !strings.HasPrefix(target, "/") {
						selectedPath = "xl/" + target
					}
					if !strings.HasPrefix(selectedPath, "xl/worksheets/") || strings.Contains(strings.TrimPrefix(selectedPath, "xl/worksheets/"), "/") || !strings.HasSuffix(selectedPath, ".xml") || entries[selectedPath] == nil {
						return errors.New("XLSX 所选工作表不存在或路径无效")
					}
					selected[selectedPath] = true
					selected["xl/worksheets/_rels/"+path.Base(selectedPath)+".rels"] = true
					selectedIDs[id] = true
				}
			}
			stack = append(stack, value.Name)
		case xml.EndElement:
			stack = stack[:len(stack)-1]
		}
		return nil
	})
	if err == nil {
		for _, found := range selectedIDs {
			if !found {
				err = errors.New("XLSX 找不到所选工作表的关系")
				break
			}
		}
	}
	return selected, err
}

func unusedWorksheet(name string, selected map[string]bool) bool {
	return selected != nil && strings.HasPrefix(name, "xl/worksheets/") && !strings.HasSuffix(name, "/") && !selected[name]
}
