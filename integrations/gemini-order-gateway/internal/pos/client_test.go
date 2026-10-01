package pos

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testKey = "test-key-123456789012345678901234567890123456789"

func TestClientSendsBearerOnlyInHeaderAndEncodesBrowse(t *testing.T) {
	var path, authorization string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		path = request.URL.RequestURI()
		authorization = request.Header.Get("Authorization")
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"success":true,"categories":[]}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, testKey, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	category, cursor := 7, 11
	if _, err := client.BrowseCatalog(context.Background(), &category, &cursor, 5); err != nil {
		t.Fatal(err)
	}
	if path != "/api/order-intake/v1/catalog/browse?category_id=7&cursor=11&limit=5" {
		t.Fatalf("unexpected path: %s", path)
	}
	if authorization != "Bearer "+testKey || strings.Contains(path, testKey[:12]) {
		t.Fatal("Bearer key was not confined to the Authorization header")
	}
}

func TestClientBoundsResponsesAndClassifiesAmbiguousCreate(t *testing.T) {
	t.Run("oversized", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"value":"` + strings.Repeat("x", maxResponseBytes) + `"}`))
		}))
		defer server.Close()
		client, _ := NewClient(server.URL, testKey, time.Second, server.Client())
		_, err := client.Status(context.Background())
		posError, ok := err.(*Error)
		if !ok || posError.Code != "POS_RESPONSE_TOO_LARGE" {
			t.Fatalf("unexpected error: %#v", err)
		}
	})

	t.Run("non-json create", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.WriteHeader(http.StatusBadGateway)
			_, _ = response.Write([]byte("<!doctype html>proxy failure"))
		}))
		defer server.Close()
		client, _ := NewClient(server.URL, testKey, time.Second, server.Client())
		_, err := client.CreateHeldOrder(context.Background(), map[string]any{})
		posError, ok := err.(*Error)
		if !ok || posError.Code != "POS_NON_JSON_RESPONSE" || !posError.Ambiguous || strings.Contains(posError.Message, "doctype") {
			t.Fatalf("unexpected error: %#v", err)
		}
	})
}

func TestClientRejectsEscapedPathsAndTimesOut(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		time.Sleep(100 * time.Millisecond)
		_, _ = response.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, testKey, 10*time.Millisecond, server.Client())
	for _, path := range []string{"https://attacker.example/collect", "//attacker.example/collect", "../../outside", `..\\outside`} {
		if _, err := client.Request(context.Background(), http.MethodGet, path, nil, false); err == nil {
			t.Fatalf("unsafe path was accepted: %s", path)
		}
	}
	_, err := client.Status(context.Background())
	posError, ok := err.(*Error)
	if !ok || posError.Code != "POS_REQUEST_TIMEOUT" {
		t.Fatalf("unexpected timeout: %s", fmt.Sprint(err))
	}
}

func TestClientDoesNotForwardBearerAcrossRedirects(t *testing.T) {
	forwarded := make(chan string, 1)
	target := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		forwarded <- request.Header.Get("Authorization")
		_, _ = response.Write([]byte(`{"success":true}`))
	}))
	defer target.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Location", target.URL)
		response.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()
	client, err := NewClient(redirector.URL, testKey, time.Second, redirector.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Status(context.Background()); err == nil {
		t.Fatal("redirect response was accepted")
	}
	select {
	case authorization := <-forwarded:
		t.Fatalf("redirect target received Authorization %q", authorization)
	default:
	}
}
