package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
)

func nativeReply(t *testing.T, w *httptest.ResponseRecorder) nativePayload {
	t.Helper()
	var reply struct {
		Data nativePayload `json:"data"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &reply) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	return reply.Data
}

func nativeCall(t *testing.T, s *comparisonServer, action string, settings nativeSettings, view viewState) nativePayload {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"action": action, "id": 1, "generation": s.data.Generation, "settings": settings, "view": view})
	return nativeReply(t, request(t, s, "POST", "compare", string(body), nil))
}

func TestNativeProjectionRetainsLabelsAndSearchesHiddenValues(t *testing.T) {
	files := fixture(t, []byte("id,name,a,hidden\n1,Alpha,0,needle\n2,Beta,0,other"), []byte("id,name,a,hidden\n1,Alpha,1,needle\n2,Beta,0,other"), "csv")
	s := testServer(t, serverOptions{Files: files})
	view := viewState{View: "grid", OnlyFields: true}
	result := nativeCall(t, s, "load", nativeSettings{Options: defaultTableOptions()}, view)
	if result.ColumnCount != 4 || len(result.Result.Fields) != 1 || result.Result.Fields[0].Name != "a" || len(result.Result.Rows[0].Cells) != 1 || result.Result.Rows[0].DisplayName != "Alpha" {
		t.Fatalf("projection lost context: %+v", result)
	}
	view.Query = "needle"
	searched := nativeCall(t, s, "view", result.Settings, view)
	if len(searched.Result.Rows) != 1 || searched.Result.Rows[0].Identity != "1" || len(searched.Result.Rows[0].Cells) != 1 {
		t.Fatal("hidden field search lost record", searched)
	}
	metadata := request(t, s, "GET", "snapshot", "", nil).Body.String()
	if strings.Contains(metadata, "needle") || strings.Contains(metadata, `"inputs"`) || strings.Contains(metadata, `"native"`) {
		t.Fatal("metadata contains original data", metadata)
	}
}

func TestNativeSettingsAreIndependentBetweenViewers(t *testing.T) {
	s := testServer(t, serverOptions{Files: fixture(t, []byte("id,v\n1,a\n1,b"), []byte("id,v\n1,c\n1,b"), "csv")})
	view := viewState{View: "grid", OnlyFields: false}
	positioned := nativeCall(t, s, "load", nativeSettings{Options: mergeOptions(nil, tableOptions{"alignment": "position"})}, view)
	if positioned.Error != "" || positioned.Result.Alignment != "position" {
		t.Fatal(positioned.Error)
	}
	automatic := nativeCall(t, s, "load", nativeSettings{Options: defaultTableOptions()}, view)
	if !strings.Contains(automatic.Error, "重复") {
		t.Fatal("one viewer changed another's alignment", automatic.Error)
	}
	recovered := nativeCall(t, s, "view", positioned.Settings, view)
	if recovered.Error != "" || recovered.Result.Alignment != "position" {
		t.Fatal("viewer preference lost", recovered.Error)
	}
}

func TestNativeCompareBoundaryAndStaleGeneration(t *testing.T) {
	s := testServer(t, serverOptions{})
	for _, body := range []string{
		`{"id":1,"generation":1,"action":"load","files":["/etc/passwd"]}`,
		`{"id":1,"generation":1,"action":"load","snapshot":{"inputs":["secret"]}}`,
		`{"id":1,"generation":1,"action":"options","options":{"alignment":"other"}}`,
		`{"id":1,"generation":1,"action":"options","options":{"keyColumns":[null]}}`,
		`{"id":1,"generation":1,"action":"load","view":{"page":-1}}`,
		`{"id":1,"generation":1,"action":"sheet","name":"absent"}`,
	} {
		if w := request(t, s, "POST", "compare", body, nil); w.Code != 400 {
			t.Fatal("invalid compare accepted", body, w.Code, w.Body.String())
		}
	}
	if w := request(t, s, "POST", "compare", `{"id":1,"generation":2,"action":"load"}`, nil); w.Code != 409 {
		t.Fatal("stale generation accepted", w.Code)
	}
	if w := request(t, s, "POST", "compare", `{"id":1,"generation":1,"action":"load"}`, map[string]string{"Origin": "https://attacker.invalid"}); w.Code != 403 {
		t.Fatal("foreign compare accepted", w.Code)
	}
	valid := nativeCall(t, s, "load", nativeSettings{Options: defaultTableOptions()}, viewState{View: "grid", OnlyFields: true})
	if valid.Error != "" || valid.Result == nil {
		t.Fatal("invalid requests poisoned comparison", valid)
	}
}

func TestNativeProjectionDoesNotTransmitUnkeyedFingerprints(t *testing.T) {
	before := "all,all,all,all\nint32,string,int32,string\nid,name,a,hidden\n编号,名称,值,隐藏\n1,Alpha,0,public\n,Comment,0,private-omitted-value"
	after := strings.Replace(before, "1,Alpha,0,public", "1,Alpha,1,public", 1)
	s := testServer(t, serverOptions{Files: fixture(t, []byte(before), []byte(after), "csv")})
	result := nativeCall(t, s, "load", nativeSettings{Options: defaultTableOptions()}, viewState{View: "grid", OnlyFields: true})
	encoded, _ := json.Marshal(result)
	if result.Error != "" || len(result.Result.Fields) != 1 || strings.Contains(string(encoded), "private-omitted-value") {
		t.Fatal("hidden fingerprint was transmitted", string(encoded))
	}
	if result.Result.Rows[1].Key != "" || !result.Result.Rows[1].Unkeyed {
		t.Fatal("unkeyed transport state invalid")
	}
}

func TestNativeCompareAcceptsBoundedLargeViewSettings(t *testing.T) {
	s := testServer(t, serverOptions{})
	result := nativeCall(t, s, "load", nativeSettings{Options: defaultTableOptions()}, viewState{View: "grid", Query: strings.Repeat("z", 70000)})
	if result.Error != "" || result.Result == nil || len(result.Result.Rows) != 0 {
		t.Fatal("valid compare settings exceeded unrelated control body cap", result.Error)
	}
}

func TestNativeManySheetsReturnOnlyNondefaultPreferences(t *testing.T) {
	n := &nativeComparison{cache: map[string]*nativeSheet{}}
	for i := 0; i < 1500; i++ {
		sheet := rawSheet{Name: fmt.Sprintf("Sheet%d", i), Values: [][]string{{"id", "v"}, {"1", "x"}}}
		n.books[0] = append(n.books[0], sheet)
		n.books[1] = append(n.books[1], sheet)
	}
	data := &snapshot{XLSX: true, SheetSelection: sheetSelection{Mode: "all"}, Sources: []string{"old.xlsx", "new.xlsx"}, Title: "new.xlsx", Generation: 1, native: n}
	result, err := n.payload(data, 1, "load", "", nil, nativeSettings{Options: defaultTableOptions()}, viewState{View: "grid"})
	if err != nil || result.Error != "" || len(result.Sheets) != 1500 || len(result.Settings.SheetOptions) > 1 {
		t.Fatal("default settings grew with sheet count", err, result.Error, len(result.Settings.SheetOptions))
	}
	settings, _ := json.Marshal(result.Settings)
	if len(settings) > 65536 {
		t.Fatal("unnecessarily large follow-up request", len(settings))
	}
}
