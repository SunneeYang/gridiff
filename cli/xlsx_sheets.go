package main

import "strings"

const spreadsheetNS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const relationshipNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const packageRelationshipNS = "http://schemas.openxmlformats.org/package/2006/relationships"
const strictSpreadsheetNS = "http://purl.oclc.org/ooxml/spreadsheetml/main"
const strictRelationshipNS = "http://purl.oclc.org/ooxml/officeDocument/relationships"

func unusedWorksheet(name string, selected map[string]bool) bool {
	return selected != nil && strings.HasPrefix(name, "xl/worksheets/") && !strings.HasSuffix(name, "/") && !selected[name]
}
