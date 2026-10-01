package ucm

import (
	"context"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/emiago/sipgo/siptest"
	"github.com/icholy/digest"

	"posapp.local/gemini-order-gateway/internal/config"
)

type registration struct {
	contact string
	expires string
	callID  string
	cseq    uint32
	source  string
	authID  string
	aor     string
}

func fakeUCM(t *testing.T, expectedPassword string) (config.UCMConfig, func() []registration) {
	t.Helper()
	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ua, err := sipgo.NewUA()
	if err != nil {
		t.Fatal(err)
	}
	server, err := sipgo.NewServer(ua)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(); ua.Close() })
	challenge := &digest.Challenge{Realm: "ucm-test", Nonce: "fixed-test-nonce", Algorithm: "MD5"}
	var mu sync.Mutex
	var registrations []registration
	server.OnRegister(func(req *sip.Request, tx sip.ServerTransaction) {
		authorization := req.GetHeader("Authorization")
		if authorization == nil {
			response := sip.NewResponseFromRequest(req, 401, "Unauthorized", nil)
			response.AppendHeader(sip.NewHeader("WWW-Authenticate", challenge.String()))
			_ = tx.Respond(response)
			return
		}
		credentials, err := digest.ParseCredentials(authorization.Value())
		if err != nil {
			_ = tx.Respond(sip.NewResponseFromRequest(req, 403, "Forbidden", nil))
			return
		}
		expected, err := digest.Digest(challenge, digest.Options{
			Method: "REGISTER", URI: credentials.URI,
			Username: credentials.Username, Password: expectedPassword,
		})
		if err != nil || credentials.Username != "test-auth" || credentials.Response != expected.Response {
			_ = tx.Respond(sip.NewResponseFromRequest(req, 403, "Forbidden", nil))
			return
		}
		mu.Lock()
		registrations = append(registrations, registration{
			contact: req.GetHeader("Contact").Value(), expires: req.GetHeader("Expires").Value(),
			callID: req.CallID().Value(), cseq: req.CSeq().SeqNo,
			source: req.Source(), authID: credentials.Username, aor: req.To().Address.User,
		})
		mu.Unlock()
		_ = tx.Respond(sip.NewResponseFromRequest(req, 200, "OK", nil))
	})
	go func() { _ = server.ServeUDP(conn) }()
	port := conn.LocalAddr().(*net.UDPAddr).Port
	settings := config.UCMConfig{
		ServerHost: "127.0.0.1", ServerPort: port,
		ListenHost: "127.0.0.1", ListenPort: 0,
		Extension: "2201", AuthID: "test-auth", Password: "correct-password",
	}
	return settings, func() []registration {
		mu.Lock()
		defer mu.Unlock()
		return append([]registration(nil), registrations...)
	}
}

func TestProbeRegistersAndUnregistersWithDigest(t *testing.T) {
	settings, records := fakeUCM(t, "correct-password")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	local, err := Probe(ctx, settings)
	if err != nil {
		t.Fatal(err)
	}
	_, portText, err := net.SplitHostPort(local)
	if err != nil {
		t.Fatal(err)
	}
	if port, _ := strconv.Atoi(portText); port < 1 {
		t.Fatalf("invalid local SIP port: %q", local)
	}
	requests := records()
	if len(requests) != 2 {
		t.Fatalf("expected authenticated register and unregister, got %+v", requests)
	}
	if requests[0].expires != "120" || requests[1].expires != "0" ||
		requests[0].callID != requests[1].callID || requests[1].cseq <= requests[0].cseq ||
		requests[0].contact != requests[1].contact || !strings.Contains(requests[0].contact, local) ||
		requests[0].authID != "test-auth" || requests[0].source != local || requests[0].aor != "2201" {
		t.Fatalf("invalid SIP registration lifecycle: %+v", requests)
	}
}

func TestProbeRejectsBadCredentialsWithoutLeakingThem(t *testing.T) {
	settings, records := fakeUCM(t, "different-password")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := Probe(ctx, settings)
	if err == nil || strings.Contains(err.Error(), settings.Password) || len(records()) != 0 {
		t.Fatalf("invalid failed-auth result: %v", err)
	}
}

func TestProbeDoesNotAnswerCustomerCalls(t *testing.T) {
	message := []byte("INVITE sip:2201@127.0.0.1 SIP/2.0\r\n" +
		"Via: SIP/2.0/UDP 127.0.0.1:5060;branch=z9hG4bK-test123\r\n" +
		"From: <sip:100@127.0.0.1>;tag=test\r\n" +
		"To: <sip:2201@127.0.0.1>\r\n" +
		"Call-ID: ucm-test-call\r\n" +
		"CSeq: 1 INVITE\r\n" +
		"Content-Length: 0\r\n\r\n")
	parsed, err := sip.NewParser().ParseSIP(message)
	if err != nil {
		t.Fatal(err)
	}
	request := parsed.(*sip.Request)
	for _, scenario := range []struct {
		source string
		want   int
	}{
		{"127.0.0.1:5060", 480},
		{"127.0.0.2:5060", 403},
	} {
		call := request.Clone()
		call.SetSource(scenario.source)
		tx := siptest.NewServerTxRecorder(call)
		respond("127.0.0.1", call, tx, 480, "Temporarily Unavailable")
		responses := tx.Result()
		if len(responses) != 1 || int(responses[0].StatusCode) != scenario.want {
			t.Fatalf("source %s received %v, want %d", scenario.source, responses, scenario.want)
		}
	}
}
