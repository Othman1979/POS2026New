package geminilive

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net"
	"sync"
	"time"

	"google.golang.org/genai"

	"posapp.local/gemini-order-gateway/internal/tools"
)

type Event struct {
	Type              string `json:"type"`
	Text              string `json:"text,omitempty"`
	Message           string `json:"message,omitempty"`
	Name              string `json:"name,omitempty"`
	State             string `json:"state,omitempty"`
	Model             string `json:"model,omitempty"`
	Voice             string `json:"voice,omitempty"`
	Resumed           bool   `json:"resumed,omitempty"`
	TimeLeftMS        int64  `json:"timeLeftMs,omitempty"`
	AudioChunks       int    `json:"audioChunks,omitempty"`
	CapturedMS        *int64 `json:"capturedMs,omitempty"`
	DurationMS        int64  `json:"durationMs,omitempty"`
	FirstTranscriptMS *int64 `json:"firstTranscriptMs,omitempty"`
	TranscriptTiming  string `json:"transcriptTiming,omitempty"`
	FirstAudioMS      *int64 `json:"firstAudioMs,omitempty"`
	Audio             []byte `json:"-"`
}

type ToolExecutor interface {
	Execute(context.Context, string, map[string]any) map[string]any
	NoteCustomerTurn()
}

type liveConnection interface {
	SendRealtimeInput(genai.LiveRealtimeInput) error
	SendToolResponse(genai.LiveToolResponseInput) error
	Receive() (*genai.LiveServerMessage, error)
	Close() error
}

type connectFunc func(context.Context, string, *genai.LiveConnectConfig) (liveConnection, error)

type activeTool struct {
	name   string
	cancel context.CancelFunc
}

type Session struct {
	model     string
	voice     string
	language  string
	executor  ToolExecutor
	onEvent   func(Event)
	connect   connectFunc
	retryMax  int
	retryBase time.Duration

	ctx                  context.Context
	cancel               context.CancelFunc
	stateMu              sync.Mutex
	sendMu               sync.Mutex
	toolMu               sync.Mutex
	cancelMu             sync.Mutex
	connection           liveConnection
	closed               bool
	resume               string
	hasAudio             bool
	inTurn               bool
	completedTurns       uint64
	handleCompletedTurns uint64
	turnStarted          time.Time
	turnEnded            time.Time
	audioChunks          int
	seenText             bool
	seenAudio            bool
	toolResults          map[string]map[string]any
	toolOrder            []string
	toolSizes            map[string]int
	toolBytes            int
	cancelled            map[string]bool
	cancelOrder          []string
	activeTools          map[string]activeTool
}

func New(client *genai.Client, model, voice, language string, executor ToolExecutor, onEvent func(Event), retryMax int, retryBase time.Duration) (*Session, error) {
	if client == nil || executor == nil {
		return nil, errors.New("Gemini Live requires a client and tool executor")
	}
	if language != "en" && language != "ar" {
		return nil, errors.New("live voice language must be en or ar")
	}
	return newWithConnector(model, voice, language, executor, onEvent, retryMax, retryBase,
		func(ctx context.Context, model string, config *genai.LiveConnectConfig) (liveConnection, error) {
			return client.Live.Connect(ctx, model, config)
		}), nil
}

func newWithConnector(model, voice, language string, executor ToolExecutor, onEvent func(Event), retryMax int, retryBase time.Duration, connector connectFunc) *Session {
	if onEvent == nil {
		onEvent = func(Event) {}
	}
	if retryMax < 1 {
		retryMax = 1
	}
	if retryBase <= 0 {
		retryBase = 750 * time.Millisecond
	}
	return &Session{
		model: model, voice: voice, language: language, executor: executor, onEvent: onEvent,
		connect: connector, retryMax: retryMax, retryBase: retryBase,
		toolResults: map[string]map[string]any{}, toolSizes: map[string]int{},
		cancelled: map[string]bool{}, activeTools: map[string]activeTool{},
	}
}

func (s *Session) Connect(parent context.Context) error {
	s.stateMu.Lock()
	if s.closed {
		s.stateMu.Unlock()
		return errors.New("Gemini Live session is closed")
	}
	if s.connection != nil {
		s.stateMu.Unlock()
		return nil
	}
	if s.ctx == nil {
		s.ctx, s.cancel = context.WithCancel(parent)
	}
	ctx := s.ctx
	s.stateMu.Unlock()
	connection, resumed, err := s.connectWithRetry(ctx)
	if err != nil {
		return err
	}
	s.setConnection(connection)
	s.emit(Event{Type: "connected"})
	s.emit(Event{Type: "ready", Model: s.model, Voice: s.voice, Resumed: resumed})
	go s.receiveForever(connection)
	return nil
}

func (s *Session) StartCustomerTurn() error {
	s.stateMu.Lock()
	s.inTurn = true
	s.turnStarted = time.Now()
	s.turnEnded = time.Time{}
	s.audioChunks = 0
	s.seenText = false
	s.seenAudio = false
	s.stateMu.Unlock()
	if err := s.sendRealtime(genai.LiveRealtimeInput{ActivityStart: &genai.ActivityStart{}}); err != nil {
		s.stateMu.Lock()
		s.inTurn = false
		s.stateMu.Unlock()
		return err
	}
	s.emit(Event{Type: "listening"})
	return nil
}

func (s *Session) SendAudio(audio []byte) error {
	if len(audio) == 0 {
		return nil
	}
	copyOfAudio := append([]byte(nil), audio...)
	if err := s.sendRealtime(genai.LiveRealtimeInput{Audio: &genai.Blob{Data: copyOfAudio, MIMEType: "audio/pcm;rate=16000"}}); err != nil {
		return err
	}
	s.stateMu.Lock()
	s.hasAudio = true
	s.audioChunks++
	s.stateMu.Unlock()
	return nil
}

func (s *Session) EndCustomerAudio() error {
	ended := time.Now()
	s.stateMu.Lock()
	s.turnEnded = ended
	started := s.turnStarted
	chunks := s.audioChunks
	s.stateMu.Unlock()
	if chunks > 0 {
		s.executor.NoteCustomerTurn()
	}
	if err := s.sendRealtime(genai.LiveRealtimeInput{ActivityEnd: &genai.ActivityEnd{}}); err != nil {
		return err
	}
	var captured *int64
	if !started.IsZero() {
		value := ended.Sub(started).Milliseconds()
		captured = &value
	}
	s.emit(Event{Type: "thinking", AudioChunks: chunks, CapturedMS: captured})
	return nil
}

func (s *Session) Close() error {
	s.stateMu.Lock()
	if s.closed {
		s.stateMu.Unlock()
		return nil
	}
	s.closed = true
	if s.cancel != nil {
		s.cancel()
	}
	connection := s.connection
	s.connection = nil
	s.stateMu.Unlock()
	if connection != nil {
		return connection.Close()
	}
	return nil
}

func (s *Session) receiveForever(connection liveConnection) {
	for {
		message, err := connection.Receive()
		if err == nil && !s.handleMessage(message) {
			continue
		}
		if err == nil {
			_ = connection.Close()
		}
		next, ok := s.reconnectConnection(connection)
		if !ok {
			return
		}
		connection = next
	}
}

func (s *Session) reconnectConnection(previous liveConnection) (liveConnection, bool) {
	s.stateMu.Lock()
	if s.connection == previous {
		s.connection = nil
	}
	closed, hasAudio, handle, ctx := s.closed, s.hasAudio, s.resume, s.ctx
	safeHandle := handle != "" && !s.inTurn && s.handleCompletedTurns == s.completedTurns
	s.stateMu.Unlock()
	if closed || ctx == nil || ctx.Err() != nil {
		return nil, false
	}
	if (hasAudio && !safeHandle) || s.hasActiveTools() {
		s.emit(Event{Type: "fatal", Message: "Voice connection interrupted before its state was safely saved. Check the held-order status before repeating this order."})
		return nil, false
	}
	s.emit(Event{Type: "disconnected", Message: "Gemini Live connection closed."})
	next, resumed, reconnectError := s.connectWithRetry(ctx)
	if reconnectError != nil {
		s.emit(Event{Type: "fatal", Message: "Gemini Live reconnection failed."})
		return nil, false
	}
	s.setConnection(next)
	s.emit(Event{Type: "ready", Model: s.model, Voice: s.voice, Resumed: resumed})
	return next, true
}

func (s *Session) connectWithRetry(ctx context.Context) (liveConnection, bool, error) {
	var lastError error
	for attempt := 1; attempt <= s.retryMax; attempt++ {
		s.stateMu.Lock()
		handle := s.resume
		s.stateMu.Unlock()
		config := s.liveConfig(handle)
		connection, err := s.connect(ctx, s.model, config)
		if err == nil {
			return connection, handle != "", nil
		}
		lastError = err
		if attempt == s.retryMax || !retryableProviderError(err) {
			break
		}
		delay := s.retryBase * time.Duration(1<<(attempt-1))
		if delay > 8*time.Second {
			delay = 8 * time.Second
		}
		delay = time.Duration(float64(delay) * (0.75 + rand.Float64()*0.5))
		s.emit(Event{Type: "reconnecting", DurationMS: delay.Milliseconds()})
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, false, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, false, fmt.Errorf("connect Gemini Live: %w", lastError)
}

func retryableProviderError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	var apiValue genai.APIError
	if errors.As(err, &apiValue) {
		return retryableProviderStatus(apiValue.Code, apiValue.Status)
	}
	var apiPointer *genai.APIError
	if errors.As(err, &apiPointer) && apiPointer != nil {
		return retryableProviderStatus(apiPointer.Code, apiPointer.Status)
	}
	var networkError net.Error
	return errors.As(err, &networkError)
}

func retryableProviderStatus(code int, status string) bool {
	if code == 408 || code == 429 || code >= 500 {
		return true
	}
	switch status {
	case "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED", "UNAVAILABLE":
		return true
	default:
		return false
	}
}

func (s *Session) liveConfig(handle string) *genai.LiveConnectConfig {
	trigger, target := int64(25_000), int64(8_000)
	config := &genai.LiveConnectConfig{
		ResponseModalities:       []genai.Modality{genai.ModalityAudio},
		SpeechConfig:             &genai.SpeechConfig{VoiceConfig: &genai.VoiceConfig{PrebuiltVoiceConfig: &genai.PrebuiltVoiceConfig{VoiceName: s.voice}}},
		SystemInstruction:        genai.NewContentFromText(voiceInstruction(s.language), genai.RoleUser),
		Tools:                    []*genai.Tool{{FunctionDeclarations: tools.Declarations()}},
		InputAudioTranscription:  &genai.AudioTranscriptionConfig{},
		OutputAudioTranscription: &genai.AudioTranscriptionConfig{},
		RealtimeInputConfig:      &genai.RealtimeInputConfig{AutomaticActivityDetection: &genai.AutomaticActivityDetection{Disabled: true}},
		SessionResumption:        &genai.SessionResumptionConfig{Handle: handle},
		ContextWindowCompression: &genai.ContextWindowCompressionConfig{TriggerTokens: &trigger, SlidingWindow: &genai.SlidingWindow{TargetTokens: &target}},
	}
	return config
}

func (s *Session) handleMessage(message *genai.LiveServerMessage) bool {
	if message == nil {
		return false
	}
	if update := message.SessionResumptionUpdate; update != nil {
		s.stateMu.Lock()
		if update.Resumable && update.NewHandle != "" {
			s.resume = update.NewHandle
			s.handleCompletedTurns = s.completedTurns
		} else {
			s.resume = ""
		}
		s.stateMu.Unlock()
	}
	if message.GoAway != nil {
		s.stateMu.Lock()
		safeHandle := s.resume != "" && !s.inTurn && s.handleCompletedTurns == s.completedTurns
		hasAudio := s.hasAudio
		s.stateMu.Unlock()
		s.emit(Event{Type: "go_away", TimeLeftMS: message.GoAway.TimeLeft.Milliseconds()})
		if (hasAudio && !safeHandle) || s.hasActiveTools() {
			s.emit(Event{Type: "fatal", Message: "Voice connection interrupted before its state was safely saved. Check the held-order status before repeating this order."})
			_ = s.Close()
			return false
		}
	}
	if cancellation := message.ToolCallCancellation; cancellation != nil {
		s.cancelToolCalls(cancellation.IDs)
	}
	if content := message.ServerContent; content != nil {
		s.handleContent(content)
	}
	if call := message.ToolCall; call != nil && len(call.FunctionCalls) > 0 {
		calls := append([]*genai.FunctionCall(nil), call.FunctionCalls...)
		go s.handleToolCalls(calls)
	}
	if message.GoAway == nil {
		return false
	}
	s.stateMu.Lock()
	hasResumeHandle := s.resume != ""
	s.stateMu.Unlock()
	return hasResumeHandle
}

func (s *Session) handleContent(content *genai.LiveServerContent) {
	if content.Interrupted {
		s.emit(Event{Type: "interrupted"})
	}
	if transcription := content.InterimInputTranscription; transcription != nil && transcription.Text != "" {
		first, elapsed, timing := s.transcriptTiming()
		event := Event{Type: "input_transcript_interim", Text: transcription.Text, TranscriptTiming: timing}
		if first {
			event.FirstTranscriptMS = elapsed
		}
		s.emit(event)
	}
	if transcription := content.InputTranscription; transcription != nil && transcription.Text != "" {
		first, elapsed, timing := s.transcriptTiming()
		event := Event{Type: "input_transcript", Text: transcription.Text, TranscriptTiming: timing}
		if first {
			event.FirstTranscriptMS = elapsed
		}
		s.emit(event)
	}
	if transcription := content.OutputTranscription; transcription != nil && transcription.Text != "" {
		s.emit(Event{Type: "output_transcript", Text: transcription.Text})
	}
	if content.ModelTurn != nil && !content.Interrupted {
		for _, part := range content.ModelTurn.Parts {
			if part == nil || part.InlineData == nil || len(part.InlineData.Data) == 0 {
				continue
			}
			s.stateMu.Lock()
			first := !s.seenAudio
			s.seenAudio = true
			ended := s.turnEnded
			s.stateMu.Unlock()
			event := Event{Type: "audio", Audio: append([]byte(nil), part.InlineData.Data...)}
			if first && !ended.IsZero() {
				value := time.Since(ended).Milliseconds()
				event.FirstAudioMS = &value
			}
			s.emit(event)
		}
	}
	if content.GenerationComplete {
		s.emit(Event{Type: "generation_complete"})
	}
	if content.TurnComplete {
		s.stateMu.Lock()
		s.inTurn = false
		s.completedTurns++
		s.stateMu.Unlock()
		s.emit(Event{Type: "turn_complete"})
	}
}

func (s *Session) hasActiveTools() bool {
	s.cancelMu.Lock()
	defer s.cancelMu.Unlock()
	return len(s.activeTools) > 0
}

func (s *Session) handleToolCalls(calls []*genai.FunctionCall) {
	s.toolMu.Lock()
	defer s.toolMu.Unlock()
	responses := make([]*genai.FunctionResponse, 0, len(calls))
	for _, call := range calls {
		if call == nil || s.isToolCancelled(call.ID) {
			continue
		}
		toolContext, finish, allowed := s.beginToolCall(call.ID, call.Name)
		if !allowed {
			continue
		}
		started := time.Now()
		s.emit(Event{Type: "tool_status", Name: call.Name, State: "started"})
		result := s.toolResults[call.ID]
		if result == nil {
			result = s.executor.Execute(toolContext, call.Name, call.Args)
			if call.ID != "" {
				s.cacheToolResult(call.ID, result)
			}
		}
		finish()
		s.emit(Event{Type: "tool_status", Name: call.Name, State: "completed", DurationMS: time.Since(started).Milliseconds()})
		if call.Name == "confirm_order" || call.Name == "request_staff" {
			if state, _ := result["state"].(string); state != "" {
				s.emit(Event{Type: "order_status", State: state})
			}
		}
		if s.isToolCancelled(call.ID) {
			continue
		}
		responses = append(responses, &genai.FunctionResponse{ID: call.ID, Name: call.Name, Response: map[string]any{"result": result}})
	}
	if len(responses) == 0 {
		return
	}
	if err := s.sendToolResponses(responses); err != nil {
		s.emit(Event{Type: "error", Message: "Order tool result could not be returned to Gemini."})
	}
}

func (s *Session) beginToolCall(id, name string) (context.Context, func(), bool) {
	s.cancelMu.Lock()
	defer s.cancelMu.Unlock()
	if id != "" && s.cancelled[id] {
		return nil, func() {}, false
	}
	ctx, cancel := context.WithCancel(s.ctx)
	if id != "" {
		s.activeTools[id] = activeTool{name: name, cancel: cancel}
	}
	return ctx, func() {
		cancel()
		if id == "" {
			return
		}
		s.cancelMu.Lock()
		delete(s.activeTools, id)
		s.pruneCancelledLocked()
		s.cancelMu.Unlock()
	}, true
}

func (s *Session) cancelToolCalls(ids []string) {
	s.cancelMu.Lock()
	defer s.cancelMu.Unlock()
	for _, id := range ids {
		if id == "" {
			continue
		}
		if !s.cancelled[id] {
			s.cancelled[id] = true
			s.cancelOrder = append(s.cancelOrder, id)
		}
		if active, exists := s.activeTools[id]; exists && active.name != "confirm_order" {
			active.cancel()
		}
	}
	s.pruneCancelledLocked()
}

func (s *Session) pruneCancelledLocked() {
	overflow := len(s.cancelOrder) - 100
	if overflow <= 0 {
		return
	}
	kept := make([]string, 0, 100)
	for _, id := range s.cancelOrder {
		if overflow > 0 {
			if _, active := s.activeTools[id]; !active {
				delete(s.cancelled, id)
				overflow--
				continue
			}
		}
		kept = append(kept, id)
	}
	s.cancelOrder = kept
}

func (s *Session) isToolCancelled(id string) bool {
	if id == "" {
		return false
	}
	s.cancelMu.Lock()
	defer s.cancelMu.Unlock()
	return s.cancelled[id]
}

func (s *Session) cacheToolResult(id string, result map[string]any) {
	encoded, _ := json.Marshal(result)
	s.toolResults[id] = result
	s.toolSizes[id] = len(encoded)
	s.toolBytes += len(encoded)
	s.toolOrder = append(s.toolOrder, id)
	for (len(s.toolOrder) > 100 || s.toolBytes > 512*1024) && len(s.toolOrder) > 1 {
		oldest := s.toolOrder[0]
		s.toolOrder = s.toolOrder[1:]
		s.toolBytes -= s.toolSizes[oldest]
		delete(s.toolSizes, oldest)
		delete(s.toolResults, oldest)
	}
}

func (s *Session) sendRealtime(input genai.LiveRealtimeInput) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	connection := s.currentConnection()
	if connection == nil {
		return errors.New("Gemini Live is not connected")
	}
	return connection.SendRealtimeInput(input)
}

func (s *Session) sendToolResponses(responses []*genai.FunctionResponse) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	connection := s.currentConnection()
	if connection == nil {
		return errors.New("Gemini Live disconnected while an order tool was running")
	}
	return connection.SendToolResponse(genai.LiveToolResponseInput{FunctionResponses: responses})
}

func (s *Session) currentConnection() liveConnection {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return s.connection
}
func (s *Session) setConnection(connection liveConnection) {
	s.stateMu.Lock()
	s.connection = connection
	s.stateMu.Unlock()
}
func (s *Session) emit(event Event) { s.onEvent(event) }

func (s *Session) transcriptTiming() (bool, *int64, string) {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	first := !s.seenText
	s.seenText = true
	reference, timing := s.turnStarted, "while_speaking"
	if !s.turnEnded.IsZero() {
		reference, timing = s.turnEnded, "after_release"
	}
	if reference.IsZero() {
		return first, nil, timing
	}
	value := time.Since(reference).Milliseconds()
	return first, &value, timing
}

func voiceInstruction(language string) string {
	languageRule := "Respond unmistakably in English. POS data in Arabic must not make you switch languages."
	if language == "ar" {
		languageRule = "Respond unmistakably in Jordanian Arabic. POS data in English must not make you switch languages."
	}
	return tools.AgentInstruction + `

Voice conversation rules:
1. Speak naturally and keep each reply brief enough for a phone call.
2. Ask one clear question at a time.
3. Do not treat background speech, partial speech, or your own readback as customer confirmation.
4. Wait for the caller's next complete response after reading the quote before calling confirm_order.
5. ` + languageRule
}
