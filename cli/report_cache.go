package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const reportCacheMarker = ".gridiff-report"
const reportCacheOwner = "Gridiff temporary report v1\n"
const reportCacheLifetime = 72 * time.Hour

func managedReport(directory string) os.FileInfo {
	if !strings.HasPrefix(filepath.Base(directory), "report-") {
		return nil
	}
	marker := filepath.Join(directory, reportCacheMarker)
	info, err := os.Lstat(marker)
	if err != nil || !info.Mode().IsRegular() || info.Size() != int64(len(reportCacheOwner)) {
		return nil
	}
	data, err := os.ReadFile(marker)
	if err != nil || string(data) != reportCacheOwner {
		return nil
	}
	return info
}

func preserveTemporaryReport(output string) error {
	directory := filepath.Dir(output)
	if managedReport(directory) == nil {
		return nil
	}
	lock, err := lockInstance(filepath.Join(filepath.Dir(directory), ".reports.lock"))
	if err != nil {
		return err
	}
	defer lock.Close()
	if managedReport(directory) == nil {
		return nil
	}
	return os.Remove(filepath.Join(directory, reportCacheMarker))
}

func removeManagedReport(directory string, entries []os.DirEntry) error {
	for _, entry := range entries {
		if entry.Name() == reportCacheMarker {
			continue
		}
		if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	// Keep ownership until data deletion succeeds, including Windows sharing failures.
	if err := os.Remove(filepath.Join(directory, reportCacheMarker)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.Remove(directory)
}

func newTemporaryReport(cacheDirectory string) (string, error) {
	root := filepath.Join(cacheDirectory, "gridiff", "reports")
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("报告缓存目录不能是符号链接或普通文件")
	}
	lock, err := lockInstance(filepath.Join(root, ".reports.lock"))
	if err != nil {
		return "", err
	}
	defer lock.Close()
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		directory := filepath.Join(root, entry.Name())
		owner := managedReport(directory)
		if owner == nil || time.Since(owner.ModTime()) < reportCacheLifetime {
			continue
		}
		children, err := os.ReadDir(directory)
		if err != nil {
			continue
		}
		owned := true
		for _, child := range children {
			if !child.Type().IsRegular() || child.Name() != reportCacheMarker && child.Name() != "report.json" && !strings.HasPrefix(child.Name(), ".gridiff-report-") {
				owned = false
				break
			}
		}
		if owned {
			if err := removeManagedReport(directory, children); err != nil && !os.IsNotExist(err) {
				fmt.Fprintln(os.Stderr, "未能回收过期报告：", err)
			}
		}
	}
	directory, err := os.MkdirTemp(root, "report-")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(directory, reportCacheMarker), []byte(reportCacheOwner), 0600); err != nil {
		os.RemoveAll(directory)
		return "", err
	}
	return filepath.Join(directory, "report.json"), nil
}
