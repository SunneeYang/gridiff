//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

func detach(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x00000008 | 0x00000200}
}
