package voice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"posapp.local/gemini-order-gateway/internal/geminilive"
)

type fakeLive struct {
	mu                    sync.Mutex
	events                func(geminilive.Event)
	started, ended, audio int
}

func (f *fakeLive) Connect(context.Context) error {
	f.events(geminilive.Event{Type: "ready"})
	return nil
}
func (f *fakeLive) StartCustomerTurn() error {
	f.mu.Lock()
	f.started++
	f.mu.Unlock()
	f.events(geminilive.Event{Type: "listening"})
	return nil
}
func (f *fakeLive) SendAudio(audio []byte) error {
	f.mu.Lock()
	f.audio += len(audio)
	f.mu.Unlock()
	return nil
}
func (f *fakeLive) EndCustomerAudio() error {
	f.mu.Lock()
	f.ended++
	f.mu.Unlock()
	f.events(geminilive.Event{Type: "turn_complete"})
	return nil
}
func (f *fakeLive) Close() error { return nil }

func TestVoiceServerServesSafeUIAndRelaysTurns(t *testing.T) {
	var live *fakeLive
	server, err := NewServer("127.0.0.1", 0, 2, func(language string, events func(geminilive.Event)) (string, LiveSession, error) {
		live = &fakeLive{events: events}
		return "call-go-0001", live, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	baseURL, err := server.Listen()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close(context.Background())
	response, err := http.Get(baseURL + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || strings.Contains(string(body), "GEMINI_API_KEY") || response.Header.Get("Content-Security-Policy") == "" {
		t.Fatal("unsafe voice UI response")
	}
	health, err := http.Get(baseURL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	var healthBody map[string]any
	_ = json.NewDecoder(health.Body).Decode(&healthBody)
	health.Body.Close()
	if healthBody["service"] != "posapp-go-voice-gateway" {
		t.Fatalf("unexpected health: %#v", healthBody)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	header := http.Header{"Origin": []string{baseURL}}
	connection, _, err := websocket.Dial(ctx, strings.Replace(baseURL, "http://", "ws://", 1)+"/voice?language=en", &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close(websocket.StatusNormalClosure, "done")
	connection.SetReadLimit(8 * 1024)
	for i := 0; i < 2; i++ {
		_, _, err = connection.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := connection.Write(ctx, websocket.MessageText, []byte(`{"type":"turn_start"}`)); err != nil {
		t.Fatal(err)
	}
	if err := connection.Write(ctx, websocket.MessageBinary, []byte{1, 2, 3, 4}); err != nil {
		t.Fatal(err)
	}
	if err := connection.Write(ctx, websocket.MessageText, []byte(`{"type":"audio_end"}`)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		live.mu.Lock()
		complete := live.started == 1 && live.ended == 1 && live.audio == 4
		live.mu.Unlock()
		if complete {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("turn was not relayed: %#v", live)
}

func TestVoiceServerBoundsConcurrentSessions(t *testing.T) {
	server, err := NewServer("127.0.0.1", 0, 1, func(string, func(geminilive.Event)) (string, LiveSession, error) {
		return "call-capacity", &fakeLive{events: func(geminilive.Event) {}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	baseURL, err := server.Listen()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close(context.Background())
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	header := http.Header{"Origin": []string{baseURL}}
	first, _, err := websocket.Dial(ctx, strings.Replace(baseURL, "http://", "ws://", 1)+"/voice", &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close(websocket.StatusNormalClosure, "done")
	_, response, err := websocket.Dial(ctx, strings.Replace(baseURL, "http://", "ws://", 1)+"/voice", &websocket.DialOptions{HTTPHeader: header})
	if err == nil {
		t.Fatal("voice server accepted more than its session limit")
	}
	if response == nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unexpected capacity response: %#v", response)
	}
}

func TestVoiceServerBoundsAudioUploadRate(t *testing.T) {
	var live *fakeLive
	server, err := NewServer("127.0.0.1", 0, 1, func(_ string, events func(geminilive.Event)) (string, LiveSession, error) {
		live = &fakeLive{events: events}
		return "call-audio-rate", live, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	baseURL, err := server.Listen()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close(context.Background())
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(ctx, strings.Replace(baseURL, "http://", "ws://", 1)+"/voice", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{baseURL}}})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close(websocket.StatusNormalClosure, "done")
	for index := 0; index < 2; index++ {
		if _, _, err := connection.Read(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if err := connection.Write(ctx, websocket.MessageText, []byte(`{"type":"turn_start"}`)); err != nil {
		t.Fatal(err)
	}
	chunk := make([]byte, 8_000)
	for index := 0; index < 40; index++ {
		if err := connection.Write(ctx, websocket.MessageBinary, chunk); err != nil {
			break
		}
	}
	closedForRate := false
	for {
		if _, _, err := connection.Read(ctx); err != nil {
			closedForRate = websocket.CloseStatus(err) == websocket.StatusPolicyViolation
			break
		}
	}
	live.mu.Lock()
	forwarded := live.audio
	live.mu.Unlock()
	if !closedForRate || forwarded > audioBurstBytes {
		t.Fatalf("rate enforcement close=%v forwarded=%d", closedForRate, forwarded)
	}
}

func TestVoiceServerConcurrentSessionSoak(t *testing.T) {
	for _, limit := range []int{1, 5, 10, 25, 50} {
		t.Run(fmt.Sprintf("sessions_%d", limit), func(t *testing.T) {
			var factories atomic.Int32
			server, err := NewServer("127.0.0.1", 0, limit, func(string, func(geminilive.Event)) (string, LiveSession, error) {
				factories.Add(1)
				return "call-soak", &fakeLive{events: func(geminilive.Event) {}}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			baseURL, err := server.Listen()
			if err != nil {
				t.Fatal(err)
			}
			defer server.Close(context.Background())
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			header := http.Header{"Origin": []string{baseURL}}
			type dialResult struct {
				connection *websocket.Conn
				err        error
			}
			results := make(chan dialResult, limit)
			for index := 0; index < limit; index++ {
				go func() {
					connection, _, err := websocket.Dial(ctx, strings.Replace(baseURL, "http://", "ws://", 1)+"/voice", &websocket.DialOptions{HTTPHeader: header})
					results <- dialResult{connection: connection, err: err}
				}()
			}
			connections := make([]*websocket.Conn, 0, limit)
			for index := 0; index < limit; index++ {
				result := <-results
				if result.err != nil {
					t.Fatalf("session %d failed: %v", index, result.err)
				}
				connections = append(connections, result.connection)
			}
			deadline := time.Now().Add(time.Second)
			for factories.Load() < int32(limit) && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			if factories.Load() != int32(limit) {
				t.Fatalf("started %d/%d sessions", factories.Load(), limit)
			}
			_, response, err := websocket.Dial(ctx, strings.Replace(baseURL, "http://", "ws://", 1)+"/voice", &websocket.DialOptions{HTTPHeader: header})
			if err == nil || response == nil || response.StatusCode != http.StatusServiceUnavailable {
				t.Fatalf("capacity was not enforced: response=%#v error=%v", response, err)
			}
			for _, connection := range connections {
				_ = connection.Close(websocket.StatusNormalClosure, "done")
			}
		})
	}
}

func TestVoiceServerRejectsCrossOrigin(t *testing.T) {
	server, _ := NewServer("127.0.0.1", 0, 1, func(string, func(geminilive.Event)) (string, LiveSession, error) { return "call", &fakeLive{}, nil })
	baseURL, _ := server.Listen()
	defer server.Close(context.Background())
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, response, err := websocket.Dial(ctx, strings.Replace(baseURL, "http://", "ws://", 1)+"/voice", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"https://attacker.example"}}})
	if err == nil {
		t.Fatal("cross-origin websocket was accepted")
	}
	if response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestProviderErrorsRedactCredentials(t *testing.T) {
	message := redactProviderError(errors.New("dial failed: https://provider.example/live?key=secret-value Authorization: Bearer token-value"))
	if strings.Contains(message, "secret-value") || strings.Contains(message, "token-value") {
		t.Fatalf("provider credential leaked in log message: %s", message)
	}
}
