package config

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	POSBaseURL       string
	POSAPIKey        string
	OutboxPath       string
	RequestTimeout   time.Duration
	RecoveryDelay    time.Duration
	GeminiAPIKey     string
	GeminiLiveModel  string
	GeminiLiveVoice  string
	GeminiRetryMax   int
	GeminiRetryBase  time.Duration
	VoiceGatewayPort int
	VoiceMaxSessions int
}

func Load(envFile string, requireGemini bool) (Config, error) {
	if envFile != "" {
		if err := loadEnvFile(envFile); err != nil {
			return Config{}, err
		}
	}
	posBaseURL, err := normalizePOSBaseURL(value("ORDER_INTAKE_BASE_URL", "http://127.0.0.1:3000"))
	if err != nil {
		return Config{}, err
	}
	posAPIKey := strings.TrimSpace(os.Getenv("ORDER_INTAKE_API_KEY"))
	if len(posAPIKey) < 32 {
		return Config{}, errors.New("ORDER_INTAKE_API_KEY must contain the raw gateway Bearer key")
	}
	geminiAPIKey := strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
	if requireGemini && geminiAPIKey == "" {
		return Config{}, errors.New("GEMINI_API_KEY is required for Gemini Live")
	}
	outboxPath, err := defaultOutboxPath()
	if err != nil {
		return Config{}, err
	}
	if configured := strings.TrimSpace(os.Getenv("ORDER_GATEWAY_OUTBOX_PATH")); configured != "" {
		outboxPath, err = filepath.Abs(configured)
		if err != nil {
			return Config{}, fmt.Errorf("resolve ORDER_GATEWAY_OUTBOX_PATH: %w", err)
		}
	}
	requestTimeout, err := boundedInteger("ORDER_GATEWAY_REQUEST_TIMEOUT_MS", 10_000, 250, 120_000)
	if err != nil {
		return Config{}, err
	}
	recoveryDelay, err := boundedInteger("ORDER_GATEWAY_RECOVERY_DELAY_MS", 250, 0, 10_000)
	if err != nil {
		return Config{}, err
	}
	voicePort, err := boundedInteger("VOICE_GATEWAY_PORT", 3199, 1024, 65_535)
	if err != nil {
		return Config{}, err
	}
	maxSessions, err := boundedInteger("VOICE_GATEWAY_MAX_SESSIONS", 32, 1, 1_000)
	if err != nil {
		return Config{}, err
	}
	retryMax, err := boundedInteger("GEMINI_RETRY_MAX_ATTEMPTS", 3, 1, 6)
	if err != nil {
		return Config{}, err
	}
	retryBase, err := boundedInteger("GEMINI_RETRY_BASE_DELAY_MS", 750, 100, 10_000)
	if err != nil {
		return Config{}, err
	}
	return Config{
		POSBaseURL:       posBaseURL,
		POSAPIKey:        posAPIKey,
		OutboxPath:       outboxPath,
		RequestTimeout:   time.Duration(requestTimeout) * time.Millisecond,
		RecoveryDelay:    time.Duration(recoveryDelay) * time.Millisecond,
		GeminiAPIKey:     geminiAPIKey,
		GeminiLiveModel:  value("GEMINI_LIVE_MODEL", "gemini-3.8-live"),
		GeminiLiveVoice:  value("GEMINI_LIVE_VOICE", "Kore"),
		GeminiRetryMax:   retryMax,
		GeminiRetryBase:  time.Duration(retryBase) * time.Millisecond,
		VoiceGatewayPort: voicePort,
		VoiceMaxSessions: maxSessions,
	}, nil
}

func normalizePOSBaseURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("ORDER_INTAKE_BASE_URL must be an absolute HTTP or HTTPS URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("ORDER_INTAKE_BASE_URL must use HTTP or HTTPS")
	}
	if parsed.User != nil {
		return "", errors.New("ORDER_INTAKE_BASE_URL must not contain credentials")
	}
	if parsed.Scheme != "https" && !IsLoopbackHostname(parsed.Hostname()) {
		return "", errors.New("remote POSApp connections require HTTPS")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func IsLoopbackHostname(hostname string) bool {
	hostname = strings.Trim(strings.ToLower(strings.TrimSpace(hostname)), "[]")
	if hostname == "localhost" {
		return true
	}
	ip := net.ParseIP(hostname)
	return ip != nil && ip.IsLoopback()
}

func boundedInteger(name string, fallback, minimum, maximum int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, fmt.Errorf("%s must be an integer from %d to %d", name, minimum, maximum)
	}
	return parsed, nil
}

func value(name, fallback string) string {
	if configured := strings.TrimSpace(os.Getenv(name)); configured != "" {
		return configured
	}
	return fallback
}

func defaultOutboxPath() (string, error) {
	var root string
	if runtime.GOOS == "windows" {
		root = value("LOCALAPPDATA", value("APPDATA", ""))
	} else {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve user home for outbox: %w", err)
		}
		root = filepath.Join(home, ".local", "state")
	}
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve user home for outbox: %w", err)
		}
		root = home
	}
	return filepath.Join(root, "POSApp", "GeminiOrderGateway", "order-gateway.sqlite"), nil
}

func loadEnvFile(filename string) error {
	file, err := os.Open(filename)
	if err != nil {
		return fmt.Errorf("open gateway environment file: %w", err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, raw, found := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !found || key == "" {
			return fmt.Errorf("invalid gateway environment line for %q", key)
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		value := strings.TrimSpace(raw)
		if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
			value = value[1 : len(value)-1]
		}
		if err := os.Setenv(key, value); err != nil {
			return fmt.Errorf("set gateway environment %s: %w", key, err)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read gateway environment file: %w", err)
	}
	return nil
}
