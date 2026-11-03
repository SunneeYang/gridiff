package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReportCacheReclaimsOnlyOwnedExpiredResults(t *testing.T) {
	cache := t.TempDir()
	allocate := func() string {
		t.Helper()
		file, err := newTemporaryReport(cache)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("report"), 0600); err != nil {
			t.Fatal(err)
		}
		return file
	}
	expired, fresh, retained, withUnknown := allocate(), allocate(), allocate(), allocate()
	old := time.Now().Add(-73 * time.Hour)
	for _, file := range []string{expired, retained, withUnknown} {
		if err := os.Chtimes(filepath.Join(filepath.Dir(file), reportCacheMarker), old, old); err != nil {
			t.Fatal(err)
		}
	}
	files := fixture(t, []byte("id,value\n1,old"), []byte("id,value\n1,new"), "csv")
	if err := run(append([]string{"--output", retained}, files...)); err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(filepath.Dir(withUnknown), "user-notes.txt")
	if err := os.WriteFile(unknown, []byte("keep me"), 0600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Dir(filepath.Dir(expired))
	unmarked := filepath.Join(root, "report-unmarked")
	if err := os.Mkdir(unmarked, 0700); err != nil {
		t.Fatal(err)
	}
	foreign := t.TempDir()
	if err := os.WriteFile(filepath.Join(foreign, reportCacheMarker), []byte(reportCacheOwner), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(foreign, reportCacheMarker), old, old); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "report-linked")
	linked := os.Symlink(foreign, link) == nil
	if _, err := newTemporaryReport(cache); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(expired)); !os.IsNotExist(err) {
		t.Fatalf("expired owned result was not reclaimed: %v", err)
	}
	for _, file := range []string{fresh, retained, unknown, unmarked, foreign} {
		if _, err := os.Stat(file); err != nil {
			t.Fatalf("cleanup touched retained or foreign data %s: %v", file, err)
		}
	}
	if linked {
		if _, err := os.Lstat(link); err != nil {
			t.Fatal("cleanup touched a symbolic link", err)
		}
	}
}

func TestReportCacheRejectsLinkedRootAndPreservesInvalidMarkers(t *testing.T) {
	cache := t.TempDir()
	file, err := newTemporaryReport(cache)
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(filepath.Dir(file), reportCacheMarker)
	if err := os.WriteFile(marker, []byte("not a Gridiff report"), 0600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-73 * time.Hour)
	if err := os.Chtimes(marker, old, old); err != nil {
		t.Fatal(err)
	}
	if _, err := newTemporaryReport(cache); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("unrecognized ownership marker was removed", err)
	}
	linkedCache := t.TempDir()
	if err := os.Mkdir(filepath.Join(linkedCache, "gridiff"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(file), filepath.Join(linkedCache, "gridiff", "reports")); err != nil {
		t.Log("symlink unavailable:", err)
		return
	}
	if _, err := newTemporaryReport(linkedCache); err == nil {
		t.Fatal("symbolic link used as managed report root")
	}
}

func TestReportCacheDeletionFailureKeepsOwnershipForRetry(t *testing.T) {
	cache := t.TempDir()
	file, err := newTemporaryReport(cache)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("report"), 0600); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Dir(file)
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	// A file replaced after inspection gives a portable deletion failure.
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(file, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(file, "busy"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := removeManagedReport(directory, entries); err == nil {
		t.Fatal("expected removal failure")
	}
	if managedReport(directory) == nil {
		t.Fatal("failed cleanup lost the ownership marker needed for retry")
	}
}

func TestReportCacheMaintenanceUsesSharedLock(t *testing.T) {
	for _, operation := range []struct {
		name string
		run  func(string, string) error
	}{
		{"allocate-and-clean", func(cache, file string) error { _, err := newTemporaryReport(cache); return err }},
		{"retain", func(cache, file string) error { return preserveTemporaryReport(file) }},
	} {
		t.Run(operation.name, func(t *testing.T) {
			cache := t.TempDir()
			file, err := newTemporaryReport(cache)
			if err != nil {
				t.Fatal(err)
			}
			lock, err := lockInstance(filepath.Join(cache, "gridiff", "reports", ".reports.lock"))
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Close()
			started, done := make(chan struct{}), make(chan error, 1)
			go func() { close(started); done <- operation.run(cache, file) }()
			<-started
			select {
			case err := <-done:
				t.Fatalf("cache operation bypassed the shared lock: %v", err)
			case <-time.After(100 * time.Millisecond):
			}
			lock.Close()
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("cache operation did not continue after releasing the lock")
			}
		})
	}
}
