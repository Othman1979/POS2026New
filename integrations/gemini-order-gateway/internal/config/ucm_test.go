package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadUCMPrivateExtension(t *testing.T) {
	t.Setenv("UCM_SIP_SERVER", "192.168.10.1:5060")
	t.Setenv("UCM_SIP_LISTEN", "192.168.10.20:5062")
	t.Setenv("UCM_SIP_EXTENSION", "2201")
	t.Setenv("UCM_SIP_AUTH_ID", "")
	t.Setenv("UCM_SIP_PASSWORD", "local-secret-123")
	settings, err := LoadUCM("")
	if err != nil {
		t.Fatal(err)
	}
	if settings.AuthID != "2201" || settings.ServerHost != "192.168.10.1" || settings.ListenPort != 5062 {
		t.Fatalf("unexpected UCM settings: %+v", settings)
	}
	for _, bad := range []string{"203.0.113.9:5060", "0.0.0.0:5060", "example.com:5060", "192.168.10.1:0"} {
		t.Setenv("UCM_SIP_SERVER", bad)
		if _, err := LoadUCM(""); err == nil {
			t.Fatalf("accepted unsafe UCM server %q", bad)
		}
	}
}

func TestLoadUCMDoesNotExposeOrOverridePassword(t *testing.T) {
	t.Setenv("UCM_SIP_SERVER", "127.0.0.1:5060")
	t.Setenv("UCM_SIP_LISTEN", "127.0.0.1:5062")
	t.Setenv("UCM_SIP_EXTENSION", "2201")
	t.Setenv("UCM_SIP_PASSWORD", "process-secret-123")
	file := filepath.Join(t.TempDir(), "gateway.env")
	if err := os.WriteFile(file, []byte("UCM_SIP_PASSWORD=file-secret-456\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	settings, err := LoadUCM(file)
	if err != nil || settings.Password != "process-secret-123" {
		t.Fatalf("process credential did not take precedence: %v", err)
	}
	t.Setenv("UCM_SIP_PASSWORD", "bad\nsecret")
	if _, err := LoadUCM(""); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("unsafe password was accepted or exposed: %v", err)
	}
}
