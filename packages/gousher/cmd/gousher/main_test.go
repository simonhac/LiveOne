package main

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInspectorBindFailureReturnsNonzero(t *testing.T) {
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	dir := t.TempDir()
	config := map[string]any{"liveoneUrl": "http://127.0.0.1:1", "receiverUrl": "http://127.0.0.1:2/capture", "dataDir": filepath.Join(dir, "data"), "listen": listener.Addr().String(), "mode": "replay"}
	data, _ := json.Marshal(config)
	path := filepath.Join(dir, "bootstrap.json")
	if e = os.WriteFile(path, data, 0600); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "go", "run", ".", "-config", path)
	command.Env = append(os.Environ(), "GOUSHER_COLLECTOR_TOKEN=local-test", "GOUSHER_RECEIVER_TOKEN=local-test", "GOUSHER_INSPECTOR_TOKEN=local-test", "GOUSHER_INSTANCE_KEY="+strings.Repeat("01", 32))
	output, e := command.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("process failed to stop: %s", output)
	}
	if e == nil {
		t.Fatalf("bind failure exited successfully, defeating Restart=on-failure: %s", output)
	}
	if !strings.Contains(string(output), "inspector stopped") {
		t.Fatalf("failed for an unrelated reason: %s", output)
	}
}
