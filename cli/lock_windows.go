//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"
)

func lockInstance(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	overlap := new(syscall.Overlapped)
	result, _, failure := syscall.NewLazyDLL("kernel32.dll").NewProc("LockFileEx").Call(file.Fd(), 2, 0, 1, 0, uintptr(unsafe.Pointer(overlap)))
	if result == 0 {
		file.Close()
		return nil, failure
	}
	return file, nil
}
