package geminilive

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/genai"
)

type receiveResult struct {
	message *genai.LiveServerMessage
	err     error
}
type fakeConnection struct {
	receive  chan receiveResult
	realtime chan genai.LiveRealtimeInput
	tools    chan genai.LiveToolResponseInput
	closed   chan struct{}
	once     sync.Once
}

func newFakeConnection() *fakeConnection {
	return &fakeConnection{receive: make(chan receiveResult, 16), realtime: make(chan genai.LiveRealtimeInput, 16), tools: make(chan genai.LiveToolResponseInput, 16), closed: make(chan struct{})}
}
func (f *fakeConnection) SendRealtimeInput(input genai.LiveRealtimeInput) error {
	f.realtime <- input
	return nil
}
func (f *fakeConnection) SendToolResponse(input genai.LiveToolResponseInput) error {
	f.tools <- input
	return nil
}
func (f *fakeConnection) Receive() (*genai.LiveServerMessage, error) {
	select {
	case result := <-f.receive:
		return result.message, result.err
	case <-f.closed:
		return nil, errors.New("closed")
	}
}
func (f *fakeConnection) Close() error { f.once.Do(func() { close(f.closed) }); return nil }

type fakeExecutor struct {
	mu    sync.Mutex
	calls int
	turns int
}

func (f *fakeExecutor) Execute(_ context.Context, name string, args map[string]any) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return map[string]any{"ok": true, "called": name}
}
func (f *fakeExecutor) NoteCustomerTurn() { f.mu.Lock(); f.turns++; f.mu.Unlock() }

type cancellableExecutor struct {
	started  chan struct{}
	canceled chan struct{}
}

func (e *cancellableExecutor) Execute(ctx context.Context, _ string, _ map[string]any) map[string]any {
	close(e.started)
	<-ctx.Done()
	close(e.canceled)
	return map[string]any{"ok": false}
}
func (e *cancellableExecutor) NoteCustomerTurn() {}

type durableConfirmExecutor struct {
	started chan struct{}
	release chan struct{}
}

func (e *durableConfirmExecutor) Execute(_ context.Context, _ string, _ map[string]any) map[string]any {
	close(e.started)
	<-e.release
	return map[string]any{"ok": true, "state": "completed"}
}
func (e *durableConfirmExecutor) NoteCustomerTurn() {}

func TestLiveSessionStreamsAudioToolsAndTranscripts(t *testing.T) {
	connection := newFakeConnection()
	executor := &fakeExecutor{}
	events := make(chan Event, 32)
	var observedConfig *genai.LiveConnectConfig
	session := newWithConnector("gemini-3.8-live", "Kore", "en", executor, func(event Event) { events <- event }, 1, time.Millisecond,
		func(_ context.Context, _ string, config *genai.LiveConnectConfig) (liveConnection, error) {
			observedConfig = config
			return connection, nil
		})
	if err := session.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if observedConfig.RealtimeInputConfig.AutomaticActivityDetection.Disabled != true || len(observedConfig.Tools) != 1 || len(observedConfig.Tools[0].FunctionDeclarations) != 7 {
		t.Fatalf("invalid live config: %#v", observedConfig)
	}
	for _, declaration := range observedConfig.Tools[0].FunctionDeclarations {
		if declaration.Behavior != genai.BehaviorBlocking {
			t.Fatalf("%s is not blocking", declaration.Name)
		}
	}
	if err := session.StartCustomerTurn(); err != nil {
		t.Fatal(err)
	}
	if input := <-connection.realtime; input.ActivityStart == nil {
		t.Fatal("missing activity start")
	}
	executor.mu.Lock()
	turnsBeforeAudioEnd := executor.turns
	executor.mu.Unlock()
	if turnsBeforeAudioEnd != 0 {
		t.Fatal("customer confirmation turn was accepted before audio ended")
	}
	if err := session.SendAudio([]byte{1, 2, 3, 4}); err != nil {
		t.Fatal(err)
	}
	if input := <-connection.realtime; input.Audio == nil || input.Audio.MIMEType != "audio/pcm;rate=16000" {
		t.Fatalf("unexpected audio: %#v", input)
	}
	if err := session.EndCustomerAudio(); err != nil {
		t.Fatal(err)
	}
	if input := <-connection.realtime; input.ActivityEnd == nil {
		t.Fatal("missing activity end")
	}

	connection.receive <- receiveResult{message: &genai.LiveServerMessage{ServerContent: &genai.LiveServerContent{
		InputTranscription: &genai.Transcription{Text: "two burgers"}, OutputTranscription: &genai.Transcription{Text: "Anything else?"},
		ModelTurn: &genai.Content{Parts: []*genai.Part{{InlineData: &genai.Blob{Data: []byte{5, 6}, MIMEType: "audio/pcm;rate=24000"}}}}, TurnComplete: true,
	}}}
	connection.receive <- receiveResult{message: &genai.LiveServerMessage{ToolCall: &genai.LiveServerToolCall{FunctionCalls: []*genai.FunctionCall{{ID: "same", Name: "list_order_types", Args: map[string]any{}}}}}}
	response := waitToolResponse(t, connection.tools)
	if len(response.FunctionResponses) != 1 || response.FunctionResponses[0].ID != "same" {
		t.Fatalf("unexpected tool response: %#v", response)
	}
	connection.receive <- receiveResult{message: &genai.LiveServerMessage{ToolCall: &genai.LiveServerToolCall{FunctionCalls: []*genai.FunctionCall{{ID: "same", Name: "list_order_types", Args: map[string]any{}}}}}}
	_ = waitToolResponse(t, connection.tools)
	executor.mu.Lock()
	calls, turns := executor.calls, executor.turns
	executor.mu.Unlock()
	if calls != 1 || turns != 1 {
		t.Fatalf("calls=%d turns=%d", calls, turns)
	}
	foundAudio, foundInput, foundOutput := false, false, false
	deadline := time.After(time.Second)
	for !(foundAudio && foundInput && foundOutput) {
		select {
		case event := <-events:
			switch event.Type {
			case "audio":
				foundAudio = len(event.Audio) == 2
			case "input_transcript":
				foundInput = event.Text == "two burgers"
			case "output_transcript":
				foundOutput = event.Text == "Anything else?"
			}
		case <-deadline:
			t.Fatal("missing live events")
		}
	}
}

func TestLiveSessionReconnectsWithResumptionHandle(t *testing.T) {
	first, second := newFakeConnection(), newFakeConnection()
	var connections atomic.Int32
	resumedHandle := make(chan string, 1)
	session := newWithConnector("gemini-3.8-live", "Kore", "en", &fakeExecutor{}, func(Event) {}, 2, time.Millisecond,
		func(_ context.Context, _ string, config *genai.LiveConnectConfig) (liveConnection, error) {
			if connections.Add(1) == 2 {
				resumedHandle <- config.SessionResumption.Handle
				return second, nil
			}
			return first, nil
		})
	if err := session.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	first.receive <- receiveResult{message: &genai.LiveServerMessage{SessionResumptionUpdate: &genai.LiveServerSessionResumptionUpdate{Resumable: true, NewHandle: "resume-123"}}}
	first.receive <- receiveResult{err: errors.New("reset")}
	select {
	case handle := <-resumedHandle:
		if handle != "resume-123" {
			t.Fatalf("session resumed with %q", handle)
		}
	case <-time.After(time.Second):
		t.Fatalf("session did not resume: connections=%d", connections.Load())
	}
}

func TestLiveSessionReconnectsBeforeGoAwayDeadline(t *testing.T) {
	first, second := newFakeConnection(), newFakeConnection()
	resumed := make(chan string, 1)
	var connections atomic.Int32
	session := newWithConnector("gemini-3.8-live", "Kore", "en", &fakeExecutor{}, func(Event) {}, 1, time.Millisecond,
		func(_ context.Context, _ string, config *genai.LiveConnectConfig) (liveConnection, error) {
			if connections.Add(1) == 2 {
				resumed <- config.SessionResumption.Handle
				return second, nil
			}
			return first, nil
		})
	if err := session.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	first.receive <- receiveResult{message: &genai.LiveServerMessage{
		SessionResumptionUpdate: &genai.LiveServerSessionResumptionUpdate{Resumable: true, NewHandle: "go-away-resume"},
		GoAway:                  &genai.LiveServerGoAway{TimeLeft: time.Second},
	}}
	select {
	case handle := <-resumed:
		if handle != "go-away-resume" {
			t.Fatalf("unexpected resumption handle %q", handle)
		}
	case <-time.After(time.Second):
		t.Fatal("session waited for server disconnect instead of reconnecting on GoAway")
	}
}

func TestLiveSessionDoesNotResumeAnInterruptedCustomerTurn(t *testing.T) {
	first := newFakeConnection()
	var connections atomic.Int32
	events := make(chan Event, 16)
	session := newWithConnector("gemini-3.8-live", "Kore", "en", &fakeExecutor{}, func(event Event) { events <- event }, 1, time.Millisecond,
		func(_ context.Context, _ string, _ *genai.LiveConnectConfig) (liveConnection, error) {
			connections.Add(1)
			return first, nil
		})
	if err := session.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	first.receive <- receiveResult{message: &genai.LiveServerMessage{SessionResumptionUpdate: &genai.LiveServerSessionResumptionUpdate{Resumable: true, NewHandle: "before-turn"}}}
	if err := session.StartCustomerTurn(); err != nil {
		t.Fatal(err)
	}
	if err := session.SendAudio([]byte{1, 2}); err != nil {
		t.Fatal(err)
	}
	first.receive <- receiveResult{message: &genai.LiveServerMessage{GoAway: &genai.LiveServerGoAway{TimeLeft: time.Second}}}
	waitEvent(t, events, "fatal")
	if connections.Load() != 1 {
		t.Fatalf("unsafe customer turn reconnected %d times", connections.Load())
	}
}

func TestLiveSessionInvalidatesNonResumableHandle(t *testing.T) {
	first := newFakeConnection()
	var connections atomic.Int32
	events := make(chan Event, 16)
	session := newWithConnector("gemini-3.8-live", "Kore", "en", &fakeExecutor{}, func(event Event) { events <- event }, 1, time.Millisecond,
		func(_ context.Context, _ string, _ *genai.LiveConnectConfig) (liveConnection, error) {
			connections.Add(1)
			return first, nil
		})
	if err := session.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	first.receive <- receiveResult{message: &genai.LiveServerMessage{SessionResumptionUpdate: &genai.LiveServerSessionResumptionUpdate{Resumable: true, NewHandle: "old-handle"}}}
	if err := session.StartCustomerTurn(); err != nil {
		t.Fatal(err)
	}
	if err := session.SendAudio([]byte{1, 2}); err != nil {
		t.Fatal(err)
	}
	if err := session.EndCustomerAudio(); err != nil {
		t.Fatal(err)
	}
	first.receive <- receiveResult{message: &genai.LiveServerMessage{SessionResumptionUpdate: &genai.LiveServerSessionResumptionUpdate{Resumable: false}}}
	first.receive <- receiveResult{err: errors.New("reset")}
	waitEvent(t, events, "fatal")
	if connections.Load() != 1 {
		t.Fatalf("stale handle reconnected %d times", connections.Load())
	}
}

func TestLiveSessionResumesAfterCompleteTurnAndFreshHandle(t *testing.T) {
	first, second := newFakeConnection(), newFakeConnection()
	events := make(chan Event, 16)
	resumed := make(chan string, 1)
	var connections atomic.Int32
	session := newWithConnector("gemini-3.8-live", "Kore", "en", &fakeExecutor{}, func(event Event) { events <- event }, 1, time.Millisecond,
		func(_ context.Context, _ string, config *genai.LiveConnectConfig) (liveConnection, error) {
			if connections.Add(1) == 2 {
				resumed <- config.SessionResumption.Handle
				return second, nil
			}
			return first, nil
		})
	if err := session.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if err := session.StartCustomerTurn(); err != nil {
		t.Fatal(err)
	}
	if err := session.SendAudio([]byte{1, 2}); err != nil {
		t.Fatal(err)
	}
	if err := session.EndCustomerAudio(); err != nil {
		t.Fatal(err)
	}
	first.receive <- receiveResult{message: &genai.LiveServerMessage{ServerContent: &genai.LiveServerContent{TurnComplete: true}}}
	waitEvent(t, events, "turn_complete")
	first.receive <- receiveResult{message: &genai.LiveServerMessage{SessionResumptionUpdate: &genai.LiveServerSessionResumptionUpdate{Resumable: true, NewHandle: "after-turn"}}}
	first.receive <- receiveResult{message: &genai.LiveServerMessage{GoAway: &genai.LiveServerGoAway{TimeLeft: time.Second}}}
	select {
	case handle := <-resumed:
		if handle != "after-turn" {
			t.Fatalf("unexpected resumption handle %q", handle)
		}
	case <-time.After(time.Second):
		t.Fatal("complete turn did not resume")
	}
}

func waitEvent(t *testing.T, events <-chan Event, wanted string) Event {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		select {
		case event := <-events:
			if event.Type == wanted {
				return event
			}
		case <-deadline:
			t.Fatalf("missing %s event", wanted)
		}
	}
}

func TestToolCancellationDoesNotBlockLiveEvents(t *testing.T) {
	connection := newFakeConnection()
	executor := &cancellableExecutor{started: make(chan struct{}), canceled: make(chan struct{})}
	events := make(chan Event, 16)
	session := newWithConnector("model", "Kore", "en", executor, func(event Event) { events <- event }, 1, time.Millisecond,
		func(context.Context, string, *genai.LiveConnectConfig) (liveConnection, error) {
			return connection, nil
		})
	if err := session.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	connection.receive <- receiveResult{message: &genai.LiveServerMessage{ToolCall: &genai.LiveServerToolCall{
		FunctionCalls: []*genai.FunctionCall{{ID: "cancel-me", Name: "browse_catalog"}},
	}}}
	select {
	case <-executor.started:
	case <-time.After(time.Second):
		t.Fatal("tool did not start")
	}
	connection.receive <- receiveResult{message: &genai.LiveServerMessage{ToolCallCancellation: &genai.LiveServerToolCallCancellation{IDs: []string{"cancel-me"}}}}
	connection.receive <- receiveResult{message: &genai.LiveServerMessage{ServerContent: &genai.LiveServerContent{Interrupted: true}}}
	select {
	case <-executor.canceled:
	case <-time.After(time.Second):
		t.Fatal("read-only tool context was not canceled")
	}
	deadline := time.After(time.Second)
	for {
		select {
		case event := <-events:
			if event.Type == "interrupted" {
				select {
				case response := <-connection.tools:
					t.Fatalf("canceled tool returned a response: %#v", response)
				default:
				}
				return
			}
		case <-deadline:
			t.Fatal("tool cancellation blocked interruption handling")
		}
	}
}

func TestCanceledConfirmationPublishesDurableOrderState(t *testing.T) {
	connection := newFakeConnection()
	executor := &durableConfirmExecutor{started: make(chan struct{}), release: make(chan struct{})}
	events := make(chan Event, 16)
	session := newWithConnector("model", "Kore", "en", executor, func(event Event) { events <- event }, 1, time.Millisecond,
		func(context.Context, string, *genai.LiveConnectConfig) (liveConnection, error) {
			return connection, nil
		})
	if err := session.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	connection.receive <- receiveResult{message: &genai.LiveServerMessage{ToolCall: &genai.LiveServerToolCall{
		FunctionCalls: []*genai.FunctionCall{{ID: "durable-confirm", Name: "confirm_order"}},
	}}}
	select {
	case <-executor.started:
	case <-time.After(time.Second):
		t.Fatal("confirmation did not start")
	}
	connection.receive <- receiveResult{message: &genai.LiveServerMessage{ToolCallCancellation: &genai.LiveServerToolCallCancellation{IDs: []string{"durable-confirm"}}}}
	cancelDeadline := time.Now().Add(time.Second)
	for !session.isToolCancelled("durable-confirm") && time.Now().Before(cancelDeadline) {
		time.Sleep(time.Millisecond)
	}
	if !session.isToolCancelled("durable-confirm") {
		t.Fatal("confirmation cancellation was not observed")
	}
	close(executor.release)
	deadline := time.After(time.Second)
	for {
		select {
		case event := <-events:
			if event.Type == "order_status" && event.State == "completed" {
				select {
				case response := <-connection.tools:
					t.Fatalf("canceled confirmation returned a stale tool response: %#v", response)
				default:
				}
				return
			}
		case <-deadline:
			t.Fatal("durable result was silent after confirmation cancellation")
		}
	}
}

func TestCancellationHistoryRemainsBoundedAroundActiveConfirmation(t *testing.T) {
	session := newWithConnector("model", "Kore", "en", &fakeExecutor{}, func(Event) {}, 1, time.Millisecond,
		func(context.Context, string, *genai.LiveConnectConfig) (liveConnection, error) {
			return newFakeConnection(), nil
		})
	session.cancelMu.Lock()
	session.activeTools["active-confirm"] = activeTool{name: "confirm_order", cancel: func() {}}
	session.cancelMu.Unlock()
	ids := []string{"active-confirm"}
	for index := 0; index < 150; index++ {
		ids = append(ids, fmt.Sprintf("canceled-%03d", index))
	}
	session.cancelToolCalls(ids)
	session.cancelMu.Lock()
	defer session.cancelMu.Unlock()
	if len(session.cancelOrder) != 100 || len(session.cancelled) != 100 || !session.cancelled["active-confirm"] {
		t.Fatalf("cancellation history is not bounded: order=%d map=%d active=%v", len(session.cancelOrder), len(session.cancelled), session.cancelled["active-confirm"])
	}
}

func TestLiveConnectRetriesOnlyTransientProviderFailures(t *testing.T) {
	t.Run("transient", func(t *testing.T) {
		connection := newFakeConnection()
		var attempts atomic.Int32
		session := newWithConnector("model", "Kore", "en", &fakeExecutor{}, func(Event) {}, 3, time.Millisecond,
			func(context.Context, string, *genai.LiveConnectConfig) (liveConnection, error) {
				if attempts.Add(1) < 3 {
					return nil, genai.APIError{Code: 503, Status: "UNAVAILABLE", Message: "busy"}
				}
				return connection, nil
			})
		if err := session.Connect(context.Background()); err != nil {
			t.Fatal(err)
		}
		defer session.Close()
		if attempts.Load() != 3 {
			t.Fatalf("attempts=%d", attempts.Load())
		}
	})

	t.Run("permanent", func(t *testing.T) {
		var attempts atomic.Int32
		session := newWithConnector("model", "Kore", "en", &fakeExecutor{}, func(Event) {}, 3, time.Millisecond,
			func(context.Context, string, *genai.LiveConnectConfig) (liveConnection, error) {
				attempts.Add(1)
				return nil, genai.APIError{Code: 400, Status: "INVALID_ARGUMENT", Message: "bad model"}
			})
		if err := session.Connect(context.Background()); err == nil {
			t.Fatal("permanent provider failure was accepted")
		}
		if attempts.Load() != 1 {
			t.Fatalf("permanent failure retried %d times", attempts.Load())
		}
	})
}

func waitToolResponse(t *testing.T, channel <-chan genai.LiveToolResponseInput) genai.LiveToolResponseInput {
	t.Helper()
	select {
	case response := <-channel:
		return response
	case <-time.After(time.Second):
		t.Fatal("tool response timed out")
		return genai.LiveToolResponseInput{}
	}
}
