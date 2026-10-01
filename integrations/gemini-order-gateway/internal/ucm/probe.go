package ucm

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"

	"posapp.local/gemini-order-gateway/internal/config"
)

const registrationSeconds = 120

type readyPacketConn struct {
	net.PacketConn
	ready chan struct{}
	once  sync.Once
}

func (conn *readyPacketConn) ReadFrom(buffer []byte) (int, net.Addr, error) {
	// sipgo adds this listener to its connection pool before reading. Wait for
	// that point so REGISTER uses the exact Contact/Via socket on Windows.
	conn.once.Do(func() { close(conn.ready) })
	return conn.PacketConn.ReadFrom(buffer)
}

// Probe registers a dedicated extension with the UCM, then removes that
// registration. It never accepts a customer call or starts Gemini.
func Probe(ctx context.Context, settings config.UCMConfig) (string, error) {
	conn, err := net.ListenPacket("udp4", net.JoinHostPort(settings.ListenHost, strconv.Itoa(settings.ListenPort)))
	if err != nil {
		return "", fmt.Errorf("bind UCM SIP listener: %w", err)
	}
	defer conn.Close()
	local := conn.LocalAddr().(*net.UDPAddr)
	ua, err := sipgo.NewUA(
		sipgo.WithUserAgent(settings.Extension),
		sipgo.WithUserAgentHostname(settings.ServerHost),
	)
	if err != nil {
		return "", errors.New("create SIP user agent")
	}
	defer ua.Close()
	server, err := sipgo.NewServer(ua)
	if err != nil {
		return "", errors.New("create SIP listener")
	}
	// The probe is deliberately not an audio adapter. A test call receives a
	// definitive unavailable response instead of ringing forever or reaching AI.
	server.OnInvite(func(request *sip.Request, transaction sip.ServerTransaction) {
		respond(settings.ServerHost, request, transaction, 480, "Temporarily Unavailable")
	})
	server.OnOptions(func(request *sip.Request, transaction sip.ServerTransaction) {
		respond(settings.ServerHost, request, transaction, 200, "OK")
	})
	served := make(chan error, 1)
	listener := &readyPacketConn{PacketConn: conn, ready: make(chan struct{})}
	go func() { served <- server.ServeUDP(listener) }()
	defer func() {
		_ = conn.Close()
		select {
		case <-served:
		case <-time.After(time.Second):
		}
	}()
	readyTimeout := time.NewTimer(2 * time.Second)
	defer readyTimeout.Stop()
	select {
	case <-listener.ready:
	case err := <-served:
		if err == nil {
			return "", errors.New("UCM SIP listener stopped before registration")
		}
		return "", fmt.Errorf("start UCM SIP listener: %w", err)
	case <-readyTimeout.C:
		return "", errors.New("UCM SIP listener did not become ready")
	case <-ctx.Done():
		return "", ctx.Err()
	}
	client, err := sipgo.NewClient(ua,
		sipgo.WithClientHostname(settings.ListenHost),
		sipgo.WithClientPort(local.Port),
		sipgo.WithClientConnectionAddr(local.String()),
	)
	if err != nil {
		return "", errors.New("create SIP registration client")
	}
	defer client.Close()

	address := net.JoinHostPort(settings.ServerHost, strconv.Itoa(settings.ServerPort))
	recipient := sip.Uri{Scheme: "sip", User: settings.Extension, Host: settings.ServerHost, Port: settings.ServerPort}
	request := sip.NewRequest(sip.REGISTER, recipient)
	request.SetTransport("UDP")
	request.SetDestination(address)
	request.AppendHeader(sip.NewHeader("Contact", fmt.Sprintf("<sip:%s@%s>", settings.Extension, local.String())))
	request.AppendHeader(sip.NewHeader("Expires", strconv.Itoa(registrationSeconds)))
	if err := register(ctx, client, request, settings); err != nil {
		return "", err
	}

	// Preserve Call-ID, From tag, Contact and increasing CSeq for removal.
	unregister := request.Clone()
	unregister.RemoveHeader("Via")
	unregister.RemoveHeader("Authorization")
	unregister.RemoveHeader("Proxy-Authorization")
	unregister.RemoveHeader("Expires")
	unregister.AppendHeader(sip.NewHeader("Expires", "0"))
	cleanup, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := register(cleanup, client, unregister, settings); err != nil {
		return "", fmt.Errorf("UCM accepted registration but could not remove it: %w", err)
	}
	return local.String(), nil
}

func register(parent context.Context, client *sipgo.Client, request *sip.Request, settings config.UCMConfig) error {
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()
	response, err := client.Do(ctx, request, sipgo.ClientRequestRegisterBuild)
	if err != nil {
		return fmt.Errorf("UCM SIP registration did not receive a response: %w", err)
	}
	if response.StatusCode == sip.StatusUnauthorized || response.StatusCode == sip.StatusProxyAuthRequired {
		response, err = client.DoDigestAuth(ctx, request, response, sipgo.DigestAuth{
			Username: settings.AuthID, Password: settings.Password,
		})
		if err != nil {
			return errors.New("UCM SIP digest authentication failed")
		}
	}
	if response.StatusCode != sip.StatusOK {
		return fmt.Errorf("UCM SIP registration returned status %d", response.StatusCode)
	}
	return nil
}

func respond(allowedHost string, request *sip.Request, transaction sip.ServerTransaction, status int, reason string) {
	host, _, err := net.SplitHostPort(request.Source())
	if err != nil || host != allowedHost {
		status, reason = 403, "Forbidden"
	}
	_ = transaction.Respond(sip.NewResponseFromRequest(request, status, reason, nil))
}
