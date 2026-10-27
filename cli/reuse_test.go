package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReusableSubmissionRequiresPrivateAuthorization(t *testing.T) {
	s := testServer(t, serverOptions{InstancePath: filepath.Join(t.TempDir(), "instance.json")})
	files := fixture(t, []byte("id,v\n1,a"), []byte("id,v\n1,b"), "csv")
	bytes, _ := json.Marshal(map[string]any{"files": files, "open": true})
	body := string(bytes)
	for _, headers := range []map[string]string{nil, {"Authorization": "Bearer bad"}, {"Authorization": "Bearer " + s.control, "Origin": s.origin}, {"Authorization": "Bearer " + s.control, "Sec-Fetch-Mode": "cors"}} {
		if w := request(t, s, "POST", "submit", body, headers); w.Code != 403 {
			t.Fatalf("unauthorized submit status %d", w.Code)
		}
	}
	if s.generation != 1 {
		t.Fatal("unauthorized submit changed the snapshot")
	}
	headers := map[string]string{"Authorization": "Bearer " + s.control}
	for _, body := range []string{`{"files":["relative.csv","other.csv"],"open":false}`, `{"files":[],"open":false}`, `{"files":["a","b"],"open":false,"extra":1}`} {
		if w := request(t, s, "POST", "submit", body, headers); w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
	if w := request(t, s, "POST", "submit", body, headers); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if s.generation != 2 {
		t.Fatal("accepted submit must change generation")
	}
}

func TestEventsKeepOnePageCurrentAndSnapshotSurvivesRemoval(t *testing.T) {
	s := testServer(t, serverOptions{InstancePath: filepath.Join(t.TempDir(), "instance.json")})
	if !s.submission(true).Open {
		t.Fatal("first invocation should open a page")
	}
	client := http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(s.URL + "events")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	read := func(want string) {
		t.Helper()
		for scanner.Scan() {
			if strings.HasPrefix(scanner.Text(), "data:") {
				if scanner.Text() != want {
					t.Fatal(scanner.Text(), want)
				}
				return
			}
		}
		t.Fatal("event stream ended", scanner.Err())
	}
	read("data: 1")
	if s.submission(true).Open {
		t.Fatal("live page should prevent another browser open")
	}
	files := fixture(t, []byte("id,v\n2,old"), []byte("id,v\n2,new"), "csv")
	reply, reachable, err := submitExisting(discovery{buildID, s.URL, s.control}, files, true, sheetSelection{})
	if err != nil || !reachable || reply.Open || reply.Generation != 2 {
		t.Fatal("submit failed", err)
	}
	for _, file := range files {
		if err := os.Remove(file); err != nil {
			t.Fatal(err)
		}
	}
	read("data: 2")
	var snapshot snapshot
	if err := json.Unmarshal(request(t, s, "GET", "snapshot", "", nil).Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Generation != 2 || s.data.native.csv[1][1][1] != "new" {
		t.Fatal("new snapshot was not retained")
	}
	response.Body.Close()
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		count := len(s.viewers)
		s.mu.Unlock()
		if count == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("closed page still registered")
		}
		time.Sleep(time.Millisecond)
	}
	if !s.submission(true).Open || s.submission(true).Open {
		t.Fatal("missing page should grant one opening lease")
	}
}

func TestDiscoveryIsPrivateValidatedAndCleaned(t *testing.T) {
	file := filepath.Join(t.TempDir(), "instance.json")
	s := testServer(t, serverOptions{InstancePath: file})
	if err := s.saveDiscovery(); err != nil {
		t.Fatal(err)
	}
	record, err := readDiscovery(file)
	if err != nil || record.URL != s.URL {
		t.Fatal(err)
	}
	for _, address := range []string{"https://127.0.0.1:1/s/", "http://example.com:1/s/", "http://127.0.0.1:0/s/", "http://127.0.0.1:12/s/" + strings.Repeat("a", 48) + "/?extra=1"} {
		bad := record
		bad.URL = address
		bytes, _ := json.Marshal(bad)
		if err := os.WriteFile(file, bytes, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readDiscovery(file); err == nil {
			t.Fatal("invalid discovery accepted")
		}
	}
	other := record
	other.Build = "other-build"
	bytes, _ := json.Marshal(other)
	_ = os.WriteFile(file, bytes, 0600)
	if _, err := readDiscovery(file); err == nil {
		t.Fatal("another build was reused")
	}
	if err := s.saveDiscovery(); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("discovery file was not removed", err)
	}
}

func TestInstanceLockSerializesCallers(t *testing.T) {
	file := filepath.Join(t.TempDir(), "instance.lock")
	first, err := lockInstance(file)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	entered := make(chan error, 1)
	go func() {
		second, err := lockInstance(file)
		if err == nil {
			second.Close()
		}
		entered <- err
	}()
	select {
	case <-entered:
		t.Fatal("lock did not block competing caller")
	case <-time.After(20 * time.Millisecond):
	}
	first.Close()
	select {
	case err := <-entered:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("lock was not released on close")
	}
}

func TestReusedPortIsStaleButInputErrorsAreNotRetried(t *testing.T) {
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "other service", 403) }))
	defer foreign.Close()
	if _, reachable, err := submitExisting(discovery{buildID, foreign.URL + "/", strings.Repeat("a", 48)}, []string{"/missing.csv", "/missing.csv"}, false, sheetSelection{}); reachable || err != nil {
		t.Fatal("foreign listener was reused", err)
	}
	s := testServer(t, serverOptions{InstancePath: filepath.Join(t.TempDir(), "instance.json")})
	if _, reachable, err := submitExisting(discovery{buildID, s.URL, s.control}, []string{filepath.Join(t.TempDir(), "missing.csv"), os.DevNull}, false, sheetSelection{}); !reachable || err == nil {
		t.Fatal("file error treated as a stale service")
	}
}

func TestReuseCarriesPerSubmissionWorksheetRange(t *testing.T) {
	parts := firstSheetFixture()
	parts["xl/worksheets/sheet1.xml"] = parts["xl/worksheets/sheet7.xml"]
	parts["xl/worksheets/_rels/sheet1.xml.rels"] = []byte(`<Relationships/>`)
	input := workbookZIP(t, parts)
	files := fixture(t, input, input, "xlsx")
	s := testServer(t, serverOptions{Files: files, InstancePath: filepath.Join(t.TempDir(), "instance.json")})
	for i, selection := range []sheetSelection{{Mode: "first"}, {Mode: "all"}, {Mode: "named", Names: []string{"Other"}}} {
		reply, reachable, err := submitExisting(discovery{buildID, s.URL, s.control}, files, false, selection)
		if err != nil || !reachable || reply.URL != s.URL || reply.Generation != uint64(i+2) {
			t.Fatal(reply, reachable, err)
		}
		s.mu.Lock()
		data := s.data
		s.mu.Unlock()
		if data.SheetSelection.Mode != selection.Mode {
			t.Fatal("selection lost on reuse", data.SheetSelection)
		}
		count := len(data.native.books[0])
		want := 1
		if selection.Mode == "all" {
			want = 2
		}
		if count != want {
			t.Fatal("wrong selected native workbook", count, want)
		}
	}
	generation := s.generation
	for _, bad := range []string{`null`, `{"mode":"unknown"}`, `{"mode":"named","names":[]}`, `{"mode":"all","names":["Other"]}`, `{"mode":"first","extra":true}`} {
		body, _ := json.Marshal(map[string]any{"files": files, "open": false, "sheetSelection": json.RawMessage(bad)})
		response := request(t, s, "POST", "submit", string(body), map[string]string{"Authorization": "Bearer " + s.control})
		if response.Code != 400 || s.generation != generation {
			t.Fatal("invalid selection replaced current snapshot", response.Code)
		}
	}
}
