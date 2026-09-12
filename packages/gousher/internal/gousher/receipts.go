package gousher

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"
)

const receiptSize = 88
const receiptBudget = 32 << 20

type receipt struct {
	Hash [32]byte
	At   time.Time
}
type receiptJournal struct {
	path    string
	offset  int64
	entries map[string]receipt
	budget  int64
}

func openReceipts(dir string) (*receiptJournal, error) {
	path := filepath.Join(dir, ".receipts", "journal")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if _, dirErr := os.Stat(filepath.Dir(path)); dirErr == nil {
			return nil, errors.New("receipt history missing; restore it before accepting deliveries")
		} else if !os.IsNotExist(dirErr) {
			return nil, dirErr
		}
		if err := AtomicWrite(path, nil); err != nil {
			return nil, err
		}
	}
	j := &receiptJournal{path: path, entries: map[string]receipt{}, budget: receiptBudget}
	return j, j.refresh(true)
}

// Caller holds the receiver's process/file locks. A partial unacknowledged tail
// can be discarded at startup; checksum failure in a complete record fails closed.
func (j *receiptJournal) refresh(recoverTail bool) error {
	f, err := os.OpenFile(j.path, os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return err
	}
	if stat.Size() < j.offset || stat.Size() > j.budget {
		return errors.New("receipt journal size invalid")
	}
	if stat.Size()%receiptSize != 0 {
		if !recoverTail {
			return errors.New("incomplete receipt journal")
		}
		if err := f.Truncate(stat.Size() / receiptSize * receiptSize); err != nil {
			return err
		}
		if err := f.Sync(); err != nil {
			return err
		}
	}
	if _, err := f.Seek(j.offset, 0); err != nil {
		return err
	}
	for {
		var b [receiptSize]byte
		_, err := io.ReadFull(f, b[:])
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if sha256.Sum256(b[:56]) != [32]byte(b[56:]) {
			return errors.New("receipt checksum mismatch")
		}
		id := hex.EncodeToString(b[:16])
		r := receipt{Hash: [32]byte(b[16:48]), At: time.Unix(0, int64(binary.BigEndian.Uint64(b[48:56])))}
		if old, ok := j.entries[id]; ok && old.Hash != r.Hash {
			return errors.New("conflicting receipt journal")
		}
		j.entries[id] = r
		j.offset += receiptSize
	}
	return nil
}
func (j *receiptJournal) append(id string, hash [32]byte, at time.Time) error {
	if old, ok := j.entries[id]; ok {
		if old.Hash != hash {
			return errors.New("conflicting receipt")
		}
		return nil
	}
	if j.offset+receiptSize > j.budget {
		return errors.New("receipt budget exhausted")
	}
	available, err := free(filepath.Dir(j.path))
	if err != nil {
		return err
	}
	if available-receiptSize < 64<<20 {
		return errors.New("receipt reserve reached")
	}
	key, err := hex.DecodeString(id)
	if err != nil || len(key) != 16 {
		return errors.New("invalid receipt ID")
	}
	var b [receiptSize]byte
	copy(b[:16], key)
	copy(b[16:48], hash[:])
	binary.BigEndian.PutUint64(b[48:56], uint64(at.UnixNano()))
	sum := sha256.Sum256(b[:56])
	copy(b[56:], sum[:])
	f, err := os.OpenFile(j.path, os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	n, err := f.Write(b[:])
	if err == nil && n != len(b) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		_ = f.Truncate(j.offset)
		_ = f.Sync()
		return err
	}
	j.offset += receiptSize
	j.entries[id] = receipt{Hash: hash, At: at}
	return nil
}
