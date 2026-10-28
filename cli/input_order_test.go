package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestInternalSnapshotPreservesOldNewOrder(t *testing.T) {
	temporary := t.TempDir()
	for _, name := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(name, temporary)
	}
	for _, directory := range []string{"manual", "fork"} {
		t.Run(directory, func(t *testing.T) {
			before := "id,name\n1,one"
			files := []string{filepath.Join(temporary, directory, "0e0caf3~", "表格/药水.csv"), filepath.Join(temporary, directory, "0e0caf3", "表格/药水.csv")}
			for i, value := range []string{before, before + "\n9,nine\n10,ten"} {
				if err := os.MkdirAll(filepath.Dir(files[i]), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(files[i], []byte(value), 0600); err != nil {
					t.Fatal(err)
				}
			}
			for _, reversed := range []bool{false, true} {
				inputs := append([]string(nil), files...)
				added, removed := 2, 0
				if reversed {
					inputs[0], inputs[1] = inputs[1], inputs[0]
					added, removed = 0, 2
				}
				data, err := makeSnapshot(inputs, sheetSelection{})
				if err != nil {
					t.Fatal(err)
				}
				result, err := data.native.payload(data, 1, "load", "", nil, nativeSettings{Options: defaultTableOptions()}, viewState{View: "grid", OnlyChanges: true})
				if err != nil || result.Error != "" || result.Result == nil {
					t.Fatalf("comparison failed: %v %s", err, result.Error)
				}
				if result.Result.Counts.Added != added || result.Result.Counts.Removed != removed || result.Settings.Swapped || !reflect.DeepEqual(data.Sources, inputs) {
					t.Fatalf("input order changed: reversed=%t added=%d removed=%d sources=%v", reversed, result.Result.Counts.Added, result.Result.Counts.Removed, data.Sources)
				}
			}
		})
	}
}

func TestCLIUsesSameOldNewOrderAsSnapshot(t *testing.T) {
	runtimeDirectory := t.TempDir()
	t.Setenv("GRIDIFF_RUNTIME_DIR", runtimeDirectory)
	before := []byte("id,name\n1,one")
	after := []byte("id,name\n1,one\n9,nine\n10,ten")
	files := fixture(t, before, after, "csv")
	s := testServer(t, serverOptions{Files: files, InstancePath: filepath.Join(runtimeDirectory, buildID+".json")})
	if err := s.saveDiscovery(); err != nil {
		t.Fatal(err)
	}
	for _, reversed := range []bool{false, true} {
		inputs := append([]string(nil), files...)
		added, removed := 2, 0
		if reversed {
			inputs[0], inputs[1] = inputs[1], inputs[0]
			added, removed = 0, 2
		}
		if err := run(append([]string{"--no-open"}, inputs...)); err != nil {
			t.Fatal(err)
		}
		result := nativeCall(t, s, "load", nativeSettings{Options: defaultTableOptions()}, viewState{View: "grid", OnlyChanges: true})
		if result.Result == nil || result.Result.Counts.Added != added || result.Result.Counts.Removed != removed || !reflect.DeepEqual(result.Sources, inputs) {
			t.Fatalf("CLI must use old/new order without remapping: reversed=%t result=%+v", reversed, result.Result)
		}
	}
}
