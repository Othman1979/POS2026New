//go:build !windows

package main

import "syscall"

func hiddenProcessAttributes() *syscall.SysProcAttr { return nil }
