package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T, before, after []byte, extension string) []string {
	t.Helper()
	directory := t.TempDir()
	files := []string{filepath.Join(directory, "旧 表."+extension), filepath.Join(directory, "new $value."+extension)}
	for i, data := range [][]byte{before, after} {
		if err := os.WriteFile(files[i], data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return files
}

func testServer(t *testing.T, options serverOptions) *comparisonServer {
	t.Helper()
	if options.Files == nil {
		options.Files = fixture(t, []byte("id,value\n001,old"), []byte("id,value\n001,new"), "csv")
	}
	if options.ConfigPath == "" {
		options.ConfigPath = filepath.Join(t.TempDir(), "settings", "preferences.json")
	}
	s, err := startServer(options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func request(t *testing.T, s *comparisonServer, method, route string, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, s.URL+route, strings.NewReader(body))
	for key, value := range headers {
		if key == "Host" {
			r.Host = value
		} else {
			r.Header.Set(key, value)
		}
	}
	if method == "POST" && r.Header.Get("Content-Type") == "" {
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestSnapshotSurvivesInputRemoval(t *testing.T) {
	files := fixture(t, []byte("id,value\n001,old"), []byte("id,value\n001,new"), "csv")
	s := testServer(t, serverOptions{Files: files})
	for _, file := range files {
		if err := os.Remove(file); err != nil {
			t.Fatal(err)
		}
	}
	w := request(t, s, "GET", "snapshot", "", nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var data snapshot
	if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if data.XLSX || data.Title != "new $value.csv" {
		t.Fatalf("unexpected snapshot: %+v", data)
	}
	if len(data.Metrics) < 4 || data.Metrics[len(data.Metrics)-1].Phase != "server.snapshot" {
		t.Fatal("missing snapshot phase measurements", data.Metrics)
	}
	for _, metric := range data.Metrics {
		if metric.MS < 0 || metric.Bytes < 0 {
			t.Fatal("invalid phase measurement", metric)
		}
	}
	if w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "worker-src 'none'") {
		t.Fatal("snapshot lacks browser security headers")
	}
	if bytes.Contains(w.Body.Bytes(), []byte(`"inputs"`)) || bytes.Contains(w.Body.Bytes(), []byte(`001,new`)) {
		t.Fatal("source leaked in metadata")
	}
	compared := request(t, s, "POST", "compare", `{"action":"load","id":1,"generation":1,"view":{"onlyChanges":false,"onlyFields":false}}`, nil)
	var response struct {
		Data nativePayload `json:"data"`
	}
	if json.Unmarshal(compared.Body.Bytes(), &response) != nil || response.Data.Result == nil || *response.Data.Result.Rows[0].Cells[1].After != "new" {
		t.Fatal("native result lost after source removal", compared.Body.String())
	}
	if _, err := os.Stat(s.configPath); !os.IsNotExist(err) {
		t.Fatal("opening a comparison must not write preferences", err)
	}
}

func TestLocalAccessBoundary(t *testing.T) {
	s := testServer(t, serverOptions{})
	for _, headers := range []map[string]string{{"Host": "attacker.invalid"}, {"Origin": "https://example.com"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}} {
		if w := request(t, s, "GET", "snapshot", "", headers); w.Code != 403 {
			t.Fatalf("accepted foreign browser request: %v %d", headers, w.Code)
		}
	}
	for _, route := range []string{"snapshot?path=/etc/passwd", "../snapshot", "unknown.js"} {
		if w := request(t, s, "GET", route, "", nil); w.Code != 404 {
			t.Fatalf("accepted unknown route %s: %d", route, w.Code)
		}
	}
	for _, body := range []string{"null", "[]", "{} {}", `{"unexpected":1}`, strings.Repeat("x", 65537)} {
		if w := request(t, s, "POST", "heartbeat", body, nil); w.Code != 400 {
			t.Fatalf("accepted invalid body: %d", w.Code)
		}
	}
	if w := request(t, s, "POST", "heartbeat", "{}", map[string]string{"Content-Type": "text/plain"}); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := request(t, s, "GET", "snapshot", "", nil); w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS must not be enabled")
	}
}

func TestPreferencesPersistOnlyThemeAndCleanTemporaryFile(t *testing.T) {
	s := testServer(t, serverOptions{})
	w := request(t, s, "GET", "preferences", "", nil)
	if !strings.Contains(w.Body.String(), `"mode":"system"`) {
		t.Fatal(w.Body.String())
	}
	w = request(t, s, "POST", "preferences", `{"mode":"dark","palette":"nord"}`, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	other := testServer(t, serverOptions{ConfigPath: s.configPath})
	w = request(t, other, "GET", "preferences", "", nil)
	if !strings.Contains(w.Body.String(), `"palette":"nord"`) {
		t.Fatal(w.Body.String())
	}
	for _, body := range []string{`{"mode":"dark","palette":"unknown"}`, `{"mode":"system","palette":"default","path":"/tmp/other"}`, `{"mode":"dark"}`} {
		if w := request(t, s, "POST", "preferences", body, nil); w.Code != 400 {
			t.Fatal("bad preferences accepted", body, w.Code)
		}
	}
	entries, err := os.ReadDir(filepath.Dir(s.configPath))
	if err != nil || len(entries) != 1 || entries[0].Name() != "preferences.json" {
		t.Fatal("preference temp file leaked", entries, err)
	}
	info, err := os.Stat(s.configPath)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("preferences permissions", info.Mode())
	}
}

func TestCloseAndTimeout(t *testing.T) {
	s := testServer(t, serverOptions{})
	response, err := http.Post(s.URL+"close", "application/json", bytes.NewBufferString("{}"))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatal(response.StatusCode)
	}
	select {
	case <-s.done:
	case <-time.After(time.Second):
		t.Fatal("close did not stop the server")
	}
	if response, err := http.Get(s.URL + "snapshot"); err == nil {
		response.Body.Close()
		t.Fatal("closed service still accepts requests")
	}
	timed := testServer(t, serverOptions{Startup: 20 * time.Millisecond})
	select {
	case <-timed.done:
	case <-time.After(time.Second):
		t.Fatal("unopened service did not expire")
	}
}

func TestFileBoundaryAndEmptyWorkbookSide(t *testing.T) {
	files := fixture(t, nil, workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`)}), "xlsx")
	data, err := makeSnapshot(files, sheetSelection{})
	if err != nil || !data.XLSX || data.Error != "" || data.native == nil {
		t.Fatal(data, err)
	}
	if _, err := readSnapshot(filepath.Dir(files[0])); err == nil {
		t.Fatal("directory accepted")
	}
	if err := os.Truncate(files[0], maxBytes+1); err != nil {
		t.Fatal(err)
	}
	if _, err := readSnapshot(files[0]); err == nil {
		t.Fatal("oversized file accepted")
	}
	invalid := fixture(t, []byte{0xff}, []byte("id,v\n1,a"), "csv")
	if _, err := makeSnapshot(invalid, sheetSelection{}); err == nil {
		t.Fatal("invalid UTF8 accepted")
	}
}

func TestParallelWorkbookSnapshotCompletesBothSidesBeforeReturning(t *testing.T) {
	left := workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`), "xl/worksheets/sheet1.xml": []byte(`<worksheet><sheetData><row r="1"><c r="A1"><f>` + strings.Repeat("A1+", 1000) + `1</f><v>1</v></c></row></sheetData></worksheet>`)})
	right := workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`), "xl/worksheets/sheet1.xml": []byte(`<worksheet><sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData></worksheet>`)})
	files := fixture(t, left, right, "xlsx")
	s := testServer(t, serverOptions{Files: files})
	for _, file := range files {
		if err := os.Remove(file); err != nil {
			t.Fatal(err)
		}
	}
	w := request(t, s, "GET", "snapshot", "", nil)
	var data snapshot
	if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || data.Error != "" || !data.XLSX {
		t.Fatal(w.Code, data.Error)
	}
	for i, expected := range []string{"1", "2"} {
		book := s.data.native.books[i]
		if len(book) != 1 || len(book[0].Values) != 1 || book[0].Values[0][0] != expected {
			t.Fatalf("side %d incomplete or swapped: %+v", i, book)
		}
	}
	if bytes.Contains(w.Body.Bytes(), []byte(`"inputs"`)) {
		t.Fatal("XLSX payload leaked to browser")
	}
	if len(data.Metrics) < 4 {
		t.Fatal("missing measurements", data.Metrics)
	}

	for _, metric := range data.Metrics {
		if metric.MS < 0 || metric.Bytes < 0 {
			t.Fatal("invalid measurement", metric)
		}
	}
}

func TestParallelWorkbookFailureKeepsLeftPriorityAndClearsBothSides(t *testing.T) {
	good := workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`)})
	badXML := workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<!DOCTYPE workbook><workbook/>`)})
	badZIP := []byte("not a zip")
	for _, pair := range [][2][]byte{{badXML, good}, {good, badZIP}, {badXML, badZIP}} {
		_, _, expected := readNativeWorkbook(pair[0], sheetSelection{})
		if expected == nil {
			_, _, expected = readNativeWorkbook(pair[1], sheetSelection{})
		}
		data, err := makeSnapshot(fixture(t, pair[0], pair[1], "xlsx"), sheetSelection{})
		if err != nil || data.Error != "无法读取 XLSX："+expected.Error() {
			t.Fatal(data, err)
		}
		if len(data.native.books[0]) != 0 || len(data.native.books[1]) != 0 {
			t.Fatal("partial snapshot survived validation failure")
		}
	}
}

func TestSnapshotRoutesOnlyByExtension(t *testing.T) {
	for _, ext := range []string{"txt", "json", "png", "pdf", "xls", "xlsb", "ods", "zip", "tmp", "csv.bak", ""} {
		t.Run(ext, func(t *testing.T) {
			files := fixture(t, []byte("id,value\n1,a"), []byte{'P', 'K', 3, 4}, ext)
			if ext == "" {
				for i, file := range files {
					files[i] = strings.TrimSuffix(file, ".")
					if err := os.Rename(file, files[i]); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := os.Truncate(files[0], maxBytes+1); err != nil {
				t.Fatal(err)
			}
			data, err := makeSnapshot(files, sheetSelection{})
			if err != nil || !data.Unsupported || !strings.Contains(data.Error, ".csv") || !strings.Contains(data.Error, ".xlsx") {
				t.Fatal(data, err)
			}
			if data.Title == "" || len(data.native.books[0]) != 0 || len(data.native.books[1]) != 0 || len(data.Metrics) != 1 || data.Metrics[0].Phase != "server.snapshot" {
				t.Fatal("unsupported inputs must not be read", data)
			}
		})
	}
	if runtime.GOOS != "windows" {
		data, err := makeSnapshot([]string{"/DEV/NULL", os.DevNull}, sheetSelection{})
		if err != nil || !data.Unsupported {
			t.Fatal("Unix null device names are case sensitive", data, err)
		}
	}
	csv := fixture(t, nil, []byte("id,value\n1,a"), "CSV")
	xlsx := fixture(t, nil, workbookZIP(t, map[string][]byte{"xl/workbook.xml": []byte(`<workbook/>`)}), "XlSx")
	for _, files := range [][]string{csv, xlsx, {os.DevNull, csv[1]}, {csv[1], os.DevNull}, {os.DevNull, xlsx[1]}, {xlsx[1], os.DevNull}} {
		data, err := makeSnapshot(files, sheetSelection{})
		if err != nil || data.Unsupported || data.Error != "" {
			t.Fatal(data, err)
		}
	}
	for _, files := range [][]string{{csv[0], xlsx[1]}, {xlsx[0], csv[1]}} {
		data, err := makeSnapshot(files, sheetSelection{})
		if err != nil || !data.Unsupported || !strings.Contains(data.Error, "混合") {
			t.Fatal(data, err)
		}
	}
	disguised := fixture(t, []byte{'P', 'K', 3, 4, 0}, []byte("id,value\n1,a"), "csv")
	if _, err := makeSnapshot(disguised, sheetSelection{}); err == nil || !strings.Contains(err.Error(), "CSV") {
		t.Fatal("CSV must not be sniffed as XLSX", err)
	}
	data, err := makeSnapshot(fixture(t, []byte("id,value\n1,a"), nil, "xlsx"), sheetSelection{})
	if err != nil || !data.XLSX || data.Unsupported || !strings.Contains(data.Error, "XLSX") {
		t.Fatal("XLSX validation was skipped", data, err)
	}
}
