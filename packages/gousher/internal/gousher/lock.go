package gousher

import (
	"errors"
	"os"
	"syscall"
)

func lockInstance(path string) (func(), error) {
	f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, errors.New("another collector owns this data directory")
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}
