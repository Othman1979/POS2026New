package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"posapp.local/gemini-order-gateway/internal/outbox"
)

func TestPOSChildEnvironmentExcludesGatewaySecrets(t *testing.T) {
	filtered := posProcessEnvironment([]string{
		"PATH=C:\\Windows",
		"GEMINI_API_KEY=secret",
		"GOOGLE_API_KEY=secret",
		"ORDER_INTAKE_API_KEY=raw-secret",
		"ORDER_INTAKE_BASE_URL=http://127.0.0.1:3110",
		"ORDER_GATEWAY_OUTBOX_PATH=private.sqlite",
		"VOICE_GATEWAY_PORT=3199",
		"UCM_SIP_PASSWORD=ucm-secret",
		"UCM_SIP_SERVER=192.168.1.1:5060",
		"ORDER_INTAKE_ENABLED=true",
	})
	joined := strings.Join(filtered, "\n")
	for _, secret := range []string{"GEMINI_API_KEY", "GOOGLE_API_KEY", "ORDER_INTAKE_API_KEY", "ORDER_GATEWAY_OUTBOX_PATH", "VOICE_GATEWAY_PORT", "UCM_SIP_PASSWORD", "UCM_SIP_SERVER"} {
		if strings.Contains(joined, secret) {
			t.Fatalf("POS child inherited %s", secret)
		}
	}
	if !strings.Contains(joined, "PATH=") || !strings.Contains(joined, "ORDER_INTAKE_ENABLED=true") {
		t.Fatalf("POS environment lost unrelated settings: %q", joined)
	}
}

func TestSimulationChecksHoldOnlyStatusBeforeRecovery(t *testing.T) {
	recoveryRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		if request.URL.Path == "/api/order-intake/v1/status" {
			_, _ = response.Write([]byte(`{"success":true,"dispatch_policy":"checkout"}`))
			return
		}
		recoveryRequests++
		_, _ = response.Write([]byte(`{"success":true,"request":null}`))
	}))
	defer server.Close()
	outboxPath := filepath.Join(t.TempDir(), "pending.sqlite")
	store, err := outbox.Open(outboxPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveDraft(map[string]any{"external_request_id": "call-preflight-0001"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveQuote("call-preflight-0001", map[string]any{"quote_token": "token"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkPending("call-preflight-0001"); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORDER_INTAKE_BASE_URL", server.URL)
	t.Setenv("ORDER_INTAKE_API_KEY", "preflight-key-123456789012345678901234567890")
	t.Setenv("ORDER_GATEWAY_OUTBOX_PATH", outboxPath)
	t.Setenv("ORDER_GATEWAY_REQUEST_TIMEOUT_MS", "1000")
	if err := runSimulation([]string{"--env="}); err == nil || !strings.Contains(err.Error(), "hold_only") {
		t.Fatalf("misconfigured target passed preflight: %v", err)
	}
	if recoveryRequests != 0 {
		t.Fatalf("recovery ran before status preflight: %d requests", recoveryRequests)
	}
}
