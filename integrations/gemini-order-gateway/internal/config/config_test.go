package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadValidatesSecurityAndBounds(t *testing.T) {
	t.Setenv("ORDER_INTAKE_API_KEY", "x12345678901234567890123456789012345678901234567")
	t.Setenv("ORDER_INTAKE_BASE_URL", "http://127.0.0.1:3110")
	t.Setenv("VOICE_GATEWAY_MAX_SESSIONS", "48")
	config, err := Load("", false)
	if err != nil {
		t.Fatal(err)
	}
	if config.POSBaseURL != "http://127.0.0.1:3110" || config.VoiceMaxSessions != 48 {
		t.Fatalf("unexpected config: %+v", config)
	}
	t.Setenv("ORDER_INTAKE_BASE_URL", "http://example.com")
	if _, err := Load("", false); err == nil {
		t.Fatal("remote plaintext POS URL was accepted")
	}
}

func TestEnvFileDoesNotOverrideProcessSecrets(t *testing.T) {
	t.Setenv("ORDER_INTAKE_API_KEY", "process-key-123456789012345678901234567890123456")
	directory := t.TempDir()
	filename := filepath.Join(directory, "gateway.env")
	if err := os.WriteFile(filename, []byte("ORDER_INTAKE_API_KEY=file-key-that-must-not-win-12345678901234567890\nORDER_INTAKE_BASE_URL=http://127.0.0.1:3110\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := Load(filename, false)
	if err != nil {
		t.Fatal(err)
	}
	if config.POSAPIKey != os.Getenv("ORDER_INTAKE_API_KEY") {
		t.Fatal("environment file overrode a process secret")
	}
}
