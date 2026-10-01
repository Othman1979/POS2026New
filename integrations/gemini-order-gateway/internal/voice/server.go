package voice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"posapp.local/gemini-order-gateway/internal/geminilive"
	voiceui "posapp.local/gemini-order-gateway/voice-ui"
)

type LiveSession interface {
	Connect(context.Context) error
	StartCustomerTurn() error
	SendAudio([]byte) error
	EndCustomerAudio() error
	Close() error
}

type SessionFactory func(language string, onEvent func(geminilive.Event)) (callID string, session LiveSession, err error)

type outboundMessage struct {
	messageType websocket.MessageType
	payload     []byte
	audio       bool
	generation  uint64
	done        chan error
}

type browserWriter struct {
	ctx        context.Context
	cancel     context.CancelFunc
	connection *websocket.Conn
	queue      chan outboundMessage
	generation atomic.Uint64
}

const maxBrowserOutputMessage = 64 * 1024
const audioBytesPerSecond = 64 * 1024
const audioBurstBytes = 256 * 1024

type Server struct {
	host        string
	port        int
	maxSessions int
	factory     SessionFactory
	http        *http.Server
	listener    net.Listener
	serveErrors chan error
	mu          sync.Mutex
	connections map[*websocket.Conn]context.CancelFunc
}

func NewServer(host string, port, maxSessions int, factory SessionFactory) (*Server, error) {
	if host != "127.0.0.1" {
		return nil, errors.New("the local voice gateway must bind to 127.0.0.1")
	}
	if port < 0 || port > 65_535 || maxSessions < 1 || factory == nil {
		return nil, errors.New("invalid local voice gateway configuration")
	}
	server := &Server{
		host: host, port: port, maxSessions: maxSessions, factory: factory,
		connections: map[*websocket.Conn]context.CancelFunc{}, serveErrors: make(chan error, 1),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", server.health)
	mux.HandleFunc("/voice", server.voice)
	mux.HandleFunc("/", server.assets)
	server.http = &http.Server{
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	return server, nil
}

func (s *Server) Listen() (string, error) {
	listener, err := net.Listen("tcp", net.JoinHostPort(s.host, strconv.Itoa(s.port)))
	if err != nil {
		return "", err
	}
	s.listener = listener
	go func() {
		if err := s.http.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			select {
			case s.serveErrors <- err:
			default:
			}
		}
	}()
	return "http://" + listener.Addr().String(), nil
}

func (s *Server) Errors() <-chan error { return s.serveErrors }

func (s *Server) Close(ctx context.Context) error {
	s.mu.Lock()
	connections := make([]*websocket.Conn, 0, len(s.connections))
	for connection, cancel := range s.connections {
		cancel()
		connections = append(connections, connection)
	}
	s.mu.Unlock()
	for _, connection := range connections {
		_ = connection.Close(websocket.StatusGoingAway, "Voice gateway stopping")
	}
	return s.http.Shutdown(ctx)
}

func (s *Server) health(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		http.NotFound(response, request)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"success": true, "service": "posapp-go-voice-gateway", "status": "UP"})
}

func (s *Server) assets(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		http.NotFound(response, request)
		return
	}
	filename := map[string]string{
		"/": "index.html", "/app.js": "app.js", "/styles.css": "styles.css", "/pcm-capture-worklet.js": "pcm-capture-worklet.js",
	}[request.URL.Path]
	if filename == "" {
		http.NotFound(response, request)
		return
	}
	body, err := fs.ReadFile(voiceui.Files, filename)
	if err != nil {
		http.Error(response, "Unable to load the local voice experiment.", http.StatusInternalServerError)
		return
	}
	contentType := map[string]string{"index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "styles.css": "text/css; charset=utf-8", "pcm-capture-worklet.js": "text/javascript; charset=utf-8"}[filename]
	response.Header().Set("Content-Type", contentType)
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Length", strconv.Itoa(len(body)))
	response.WriteHeader(http.StatusOK)
	if request.Method == http.MethodGet {
		_, _ = response.Write(body)
	}
}

func (s *Server) voice(response http.ResponseWriter, request *http.Request) {
	language := request.URL.Query().Get("language")
	if language == "" {
		language = "en"
	}
	if language != "en" && language != "ar" || !s.originAllowed(request) {
		http.Error(response, "Forbidden", http.StatusForbidden)
		return
	}
	s.mu.Lock()
	if len(s.connections) >= s.maxSessions {
		s.mu.Unlock()
		http.Error(response, "Voice gateway is at capacity", http.StatusServiceUnavailable)
		return
	}
	s.mu.Unlock()
	connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	connection.SetReadLimit(8 * 1024)
	ctx, cancel := context.WithCancel(request.Context())
	s.mu.Lock()
	if len(s.connections) >= s.maxSessions {
		s.mu.Unlock()
		cancel()
		_ = connection.Close(websocket.StatusTryAgainLater, "Voice gateway is at capacity")
		return
	}
	s.connections[connection] = cancel
	s.mu.Unlock()
	defer func() {
		cancel()
		s.mu.Lock()
		delete(s.connections, connection)
		s.mu.Unlock()
		_ = connection.Close(websocket.StatusNormalClosure, "Voice session ended")
	}()

	writer := newBrowserWriter(ctx, cancel, connection)
	go writer.run()
	var inCustomerTurn atomic.Bool
	audioBudget := float64(audioBurstBytes)
	lastAudioAt := time.Now()

	relay := func(event geminilive.Event) {
		if event.Type == "go_away" {
			inCustomerTurn.Store(false)
		}
		if event.Type == "interrupted" {
			writer.discardQueuedAudio()
		}
		if event.Type == "audio" {
			if len(event.Audio) > 0 {
				_ = writer.writeAudio(event.Audio)
			}
			if event.FirstAudioMS != nil {
				_ = writer.writeText(geminilive.Event{Type: "first_audio", FirstAudioMS: event.FirstAudioMS}, false)
			}
			return
		}
		wait := event.Type == "fatal"
		_ = writer.writeText(event, wait)
		if event.Type == "fatal" {
			cancel()
		}
	}
	callID, live, err := s.factory(language, relay)
	if err != nil {
		_ = writer.writeText(geminilive.Event{Type: "fatal", Message: "Unable to create Gemini Live session."}, true)
		return
	}
	defer live.Close()
	if err := writer.writeText(map[string]any{"type": "session", "callId": callID}, true); err != nil {
		return
	}
	if err := live.Connect(ctx); err != nil {
		log.Printf("Gemini Live session could not start: %s", redactProviderError(err))
		_ = writer.writeText(geminilive.Event{Type: "fatal", Message: "Unable to start Gemini Live."}, true)
		return
	}
	for {
		messageType, payload, err := connection.Read(ctx)
		if err != nil {
			return
		}
		if messageType == websocket.MessageBinary {
			if !inCustomerTurn.Load() {
				continue
			}
			if len(payload) == 0 || len(payload)%2 != 0 {
				_ = writer.writeText(geminilive.Event{Type: "error", Message: "Invalid PCM audio chunk."}, false)
				continue
			}
			now := time.Now()
			audioBudget += now.Sub(lastAudioAt).Seconds() * audioBytesPerSecond
			if audioBudget > audioBurstBytes {
				audioBudget = audioBurstBytes
			}
			lastAudioAt = now
			if float64(len(payload)) > audioBudget {
				_ = connection.Close(websocket.StatusPolicyViolation, "Audio was sent faster than real time")
				return
			}
			audioBudget -= float64(len(payload))
			if err := live.SendAudio(payload); err != nil {
				_ = writer.writeText(geminilive.Event{Type: "error", Message: "Voice audio could not be sent."}, false)
			}
			continue
		}
		var control struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(payload, &control); err != nil {
			_ = writer.writeText(geminilive.Event{Type: "error", Message: "Invalid voice control message."}, false)
			continue
		}
		switch control.Type {
		case "turn_start":
			if !inCustomerTurn.CompareAndSwap(false, true) {
				continue
			}
			if err := live.StartCustomerTurn(); err != nil {
				inCustomerTurn.Store(false)
				_ = writer.writeText(geminilive.Event{Type: "error", Message: "Voice turn could not start."}, false)
				continue
			}
		case "audio_end":
			if !inCustomerTurn.Swap(false) {
				continue
			}
			if err := live.EndCustomerAudio(); err != nil {
				_ = writer.writeText(geminilive.Event{Type: "error", Message: "Voice turn could not finish."}, false)
			}
		default:
			_ = writer.writeText(geminilive.Event{Type: "error", Message: "Unknown voice control message."}, false)
		}
	}
}

func newBrowserWriter(ctx context.Context, cancel context.CancelFunc, connection *websocket.Conn) *browserWriter {
	return &browserWriter{ctx: ctx, cancel: cancel, connection: connection, queue: make(chan outboundMessage, 32)}
}

func (w *browserWriter) run() {
	for {
		select {
		case <-w.ctx.Done():
			return
		case message := <-w.queue:
			if message.audio && message.generation != w.generation.Load() {
				if message.done != nil {
					message.done <- nil
				}
				continue
			}
			writeCtx, cancelWrite := context.WithTimeout(w.ctx, time.Second)
			err := w.connection.Write(writeCtx, message.messageType, message.payload)
			cancelWrite()
			if message.done != nil {
				message.done <- err
			}
			if err != nil {
				w.cancel()
				return
			}
		}
	}
}

func (w *browserWriter) writeText(value any, wait bool) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return w.enqueue(outboundMessage{messageType: websocket.MessageText, payload: encoded}, wait)
}

func (w *browserWriter) writeAudio(audio []byte) error {
	return w.enqueue(outboundMessage{
		messageType: websocket.MessageBinary,
		payload:     append([]byte(nil), audio...),
		audio:       true,
		generation:  w.generation.Load(),
	}, false)
}

func (w *browserWriter) enqueue(message outboundMessage, wait bool) error {
	if len(message.payload) > maxBrowserOutputMessage {
		w.cancel()
		return errors.New("browser voice output message is too large")
	}
	if wait {
		message.done = make(chan error, 1)
	}
	select {
	case <-w.ctx.Done():
		return w.ctx.Err()
	case w.queue <- message:
	default:
		w.cancel()
		return errors.New("browser voice output queue is full")
	}
	if message.done == nil {
		return nil
	}
	select {
	case <-w.ctx.Done():
		return w.ctx.Err()
	case err := <-message.done:
		return err
	}
}

func (w *browserWriter) discardQueuedAudio() { w.generation.Add(1) }

var providerSecretPattern = regexp.MustCompile(`(?i)(key=|api[_-]?key[=: ]+|authorization[=: ]+bearer[ ]+)[^&\s]+`)

func redactProviderError(err error) string {
	if err == nil {
		return "unknown provider error"
	}
	return providerSecretPattern.ReplaceAllString(err.Error(), "${1}[redacted]")
}

func (s *Server) originAllowed(request *http.Request) bool {
	origin := request.Header.Get("Origin")
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "http" || !configLoopback(parsed.Hostname()) {
		return false
	}
	return parsed.Host == request.Host
}

func configLoopback(host string) bool {
	host = strings.Trim(strings.ToLower(host), "[]")
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; media-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		response.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(response, request)
	})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		http.Error(response, "Unable to encode response.", http.StatusInternalServerError)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_, _ = response.Write(encoded)
}

func (s *Server) URL() string {
	if s.listener == nil {
		return ""
	}
	return fmt.Sprintf("http://%s", s.listener.Addr().String())
}
