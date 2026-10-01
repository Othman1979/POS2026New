package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
)

var sipIdentity = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)
var sipExtension = regexp.MustCompile(`^[0-9]{2,12}$`)

// UCMConfig is deliberately limited to a private-network UDP SIP extension.
// RTP and customer calls are not enabled by the registration probe.
type UCMConfig struct {
	ServerHost string
	ServerPort int
	ListenHost string
	ListenPort int
	Extension  string
	AuthID     string
	Password   string
}

func LoadUCM(envFile string) (UCMConfig, error) {
	if envFile != "" {
		if err := loadEnvFile(envFile); err != nil {
			return UCMConfig{}, err
		}
	}
	serverHost, serverPort, err := privateSIPAddress("UCM_SIP_SERVER", os.Getenv("UCM_SIP_SERVER"))
	if err != nil {
		return UCMConfig{}, err
	}
	listenHost, listenPort, err := privateSIPAddress("UCM_SIP_LISTEN", os.Getenv("UCM_SIP_LISTEN"))
	if err != nil {
		return UCMConfig{}, err
	}
	extension := strings.TrimSpace(os.Getenv("UCM_SIP_EXTENSION"))
	if !sipExtension.MatchString(extension) {
		return UCMConfig{}, errors.New("UCM_SIP_EXTENSION must contain 2 to 12 digits")
	}
	authID := value("UCM_SIP_AUTH_ID", extension)
	if !sipIdentity.MatchString(authID) {
		return UCMConfig{}, errors.New("UCM_SIP_AUTH_ID contains unsupported characters")
	}
	password := os.Getenv("UCM_SIP_PASSWORD")
	if password == "" || strings.ContainsAny(password, "\r\n") {
		return UCMConfig{}, errors.New("UCM_SIP_PASSWORD must be configured without line breaks")
	}
	return UCMConfig{
		ServerHost: serverHost, ServerPort: serverPort,
		ListenHost: listenHost, ListenPort: listenPort,
		Extension: extension, AuthID: authID, Password: password,
	}, nil
}

func privateSIPAddress(name, raw string) (string, int, error) {
	host, portText, err := net.SplitHostPort(strings.TrimSpace(raw))
	if err != nil {
		return "", 0, fmt.Errorf("%s must be a private IPv4 address and port", name)
	}
	ip := net.ParseIP(host)
	port, err := strconv.Atoi(portText)
	if ip == nil || ip.To4() == nil || !(ip.IsPrivate() || ip.IsLoopback()) || port < 1 || port > 65535 || ip.IsUnspecified() {
		return "", 0, fmt.Errorf("%s must be a private IPv4 address and port", name)
	}
	return ip.String(), port, nil
}
