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
	if data.XLSX || data.Inputs[1] != "id,value\n001,new" || data.Title != "new $value.csv" {
		t.Fatalf("unexpected snapshot: %+v", data)
	}
	if w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "worker-src 'self'") {
		t.Fatal("snapshot lacks browser security headers")
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
	data, err := makeSnapshot(files)
	if err != nil || !data.XLSX || data.Error != "" || data.Inputs[0] != "" || data.Inputs[1] == "" {
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
	if _, err := makeSnapshot(invalid); err == nil {
		t.Fatal("invalid UTF8 accepted")
	}
	mixed := fixture(t, []byte{'P', 'K', 3, 4}, []byte("id,v\n1,a"), "tmp")
	if _, err := makeSnapshot(mixed); err == nil {
		t.Fatal("mixed CSV/XLSX accepted")
	}
}
