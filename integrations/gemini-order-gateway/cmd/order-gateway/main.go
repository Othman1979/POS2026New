package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"google.golang.org/genai"

	"posapp.local/gemini-order-gateway/internal/config"
	"posapp.local/gemini-order-gateway/internal/gateway"
	"posapp.local/gemini-order-gateway/internal/geminilive"
	"posapp.local/gemini-order-gateway/internal/outbox"
	"posapp.local/gemini-order-gateway/internal/pos"
	ordertool "posapp.local/gemini-order-gateway/internal/tools"
	"posapp.local/gemini-order-gateway/internal/ucm"
	"posapp.local/gemini-order-gateway/internal/voice"
)

type components struct {
	config config.Config
	store  *outbox.Store
	pos    *pos.Client
	orders *gateway.Gateway
}

type managedProcess struct {
	command *exec.Cmd
	done    chan error
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "%s: %s\n", errorCode(err), err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	if len(arguments) == 0 {
		usage()
		return errors.New("a command is required")
	}
	switch arguments[0] {
	case "voice":
		return runVoice(arguments[1:], false)
	case "local":
		return runVoice(arguments[1:], true)
	case "simulate":
		return runSimulation(arguments[1:])
	case "ucm-probe":
		return runUCMProbe(arguments[1:])
	case "help", "-h", "--help":
		usage()
		return nil
	default:
		usage()
		return fmt.Errorf("unknown command %q", arguments[0])
	}
}

func usage() {
	fmt.Println(`POSApp Go order gateway

Usage:
  posapp-order-gateway voice [--env gateway.env] [--allow-remote-submit]
  posapp-order-gateway local [--env gateway.env] [--repo-root path]
  posapp-order-gateway simulate [options]
  posapp-order-gateway ucm-probe [--env gateway.env]

The voice command connects to an already-running POSApp. The local command
starts POSApp when its exact loopback health check is unavailable. The UCM
probe registers and immediately unregisters a SIP extension; it does not
answer calls or route audio to Gemini.`)
}

func runUCMProbe(arguments []string) error {
	flags := flag.NewFlagSet("ucm-probe", flag.ContinueOnError)
	envFile := flags.String("env", "gateway.env", "gateway environment file")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("ucm-probe does not accept positional arguments")
	}
	settings, err := config.LoadUCM(*envFile)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	localAddress, err := ucm.Probe(ctx, settings)
	if err != nil {
		return err
	}
	fmt.Printf("UCM SIP extension %s registered and unregistered successfully (local %s). Customer calls remain disabled.\n", settings.Extension, localAddress)
	return nil
}

func openComponents(envFile string, requireGemini bool) (*components, error) {
	settings, err := config.Load(envFile, requireGemini)
	if err != nil {
		return nil, err
	}
	store, err := outbox.Open(settings.OutboxPath)
	if err != nil {
		return nil, err
	}
	posClient, err := pos.NewClient(settings.POSBaseURL, settings.POSAPIKey, settings.RequestTimeout, nil)
	if err != nil {
		store.Close()
		return nil, err
	}
	orderGateway, err := gateway.New(posClient, store, settings.RecoveryDelay)
	if err != nil {
		store.Close()
		return nil, err
	}
	return &components{config: settings, store: store, pos: posClient, orders: orderGateway}, nil
}

func runVoice(arguments []string, managePOS bool) error {
	flags := flag.NewFlagSet("voice", flag.ContinueOnError)
	envFile := flags.String("env", "gateway.env", "gateway environment file")
	repoRoot := flags.String("repo-root", "", "POSApp repository root used by local mode")
	allowRemote := flags.Bool("allow-remote-submit", false, "permit voice-created holds and recovery on a non-loopback POSApp")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	settings, err := config.Load(*envFile, true)
	if err != nil {
		return err
	}
	var posProcess *managedProcess
	if managePOS {
		posProcess, err = ensureLocalPOS(ctx, settings.POSBaseURL, *repoRoot)
		if err != nil {
			return err
		}
		if posProcess != nil {
			defer posProcess.stop()
		}
	}
	parts, err := openComponents("", true)
	if err != nil {
		return err
	}
	defer parts.store.Close()
	if !parts.pos.IsLoopback() && !*allowRemote {
		return errors.New("remote voice order creation requires --allow-remote-submit")
	}
	fatal := make(chan error, 1)
	if posProcess != nil {
		go func() {
			if childError := <-posProcess.done; ctx.Err() == nil {
				if childError == nil {
					childError = errors.New("POSApp stopped unexpectedly")
				} else {
					childError = fmt.Errorf("POSApp stopped unexpectedly: %w", childError)
				}
				fatal <- childError
				stop()
			}
		}()
	}
	status, err := parts.orders.Status(ctx)
	if err != nil {
		return fmt.Errorf("verify POSApp order intake: %w", err)
	}
	if status["dispatch_policy"] != "hold_only" {
		return errors.New("POSApp order intake did not report the required hold_only dispatch policy")
	}
	recovered, err := parts.orders.RecoverPending(ctx)
	if err != nil {
		return fmt.Errorf("recover durable order requests: %w", err)
	}
	go recoverDurableOrders(ctx, parts.orders, 15*time.Second)
	client, err := genai.NewClient(ctx, &genai.ClientConfig{APIKey: parts.config.GeminiAPIKey, Backend: genai.BackendGeminiAPI})
	if err != nil {
		return fmt.Errorf("create Gemini client: %w", err)
	}
	factory := func(language string, onEvent func(geminilive.Event)) (string, voice.LiveSession, error) {
		callID, err := gateway.NewExternalRequestID()
		if err != nil {
			return "", nil, err
		}
		executor, err := ordertool.NewExecutor(parts.orders, callID, ctx)
		if err != nil {
			return "", nil, err
		}
		session, err := geminilive.New(
			client,
			parts.config.GeminiLiveModel,
			parts.config.GeminiLiveVoice,
			language,
			executor,
			onEvent,
			parts.config.GeminiRetryMax,
			parts.config.GeminiRetryBase,
		)
		return callID, session, err
	}
	server, err := voice.NewServer("127.0.0.1", parts.config.VoiceGatewayPort, parts.config.VoiceMaxSessions, factory)
	if err != nil {
		return err
	}
	address, err := server.Listen()
	if err != nil {
		return fmt.Errorf("start local voice gateway: %w", err)
	}
	fmt.Printf("POSApp Go voice gateway is ready at %s (recovered=%d, max_sessions=%d).\n", address, len(recovered), parts.config.VoiceMaxSessions)
	var runError error
	select {
	case <-ctx.Done():
		select {
		case runError = <-fatal:
		default:
		}
	case runError = <-server.Errors():
		stop()
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	closeError := server.Close(shutdown)
	if runError != nil {
		return runError
	}
	return closeError
}

func recoverDurableOrders(ctx context.Context, orders *gateway.Gateway, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := orders.RecoverPending(ctx); err != nil && ctx.Err() == nil {
				log.Printf("Durable order recovery will retry: %s", err)
			}
		}
	}
}

func runSimulation(arguments []string) error {
	flags := flag.NewFlagSet("simulate", flag.ContinueOnError)
	envFile := flags.String("env", "gateway.env", "gateway environment file")
	query := flags.String("query", "a", "catalog search text")
	productID := flags.Int("product-id", 0, "selected product id")
	orderTypeID := flags.Int("order-type-id", 0, "selected order type id")
	quantity := flags.Float64("quantity", 1, "item quantity")
	callID := flags.String("call-id", "", "stable external request id")
	submit := flags.Bool("submit", false, "create the held order after quoting")
	recoverOnly := flags.Bool("recover-only", false, "recover durable requests and exit")
	allowRemote := flags.Bool("allow-remote-submit", false, "permit writes to a non-loopback POSApp")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if *quantity <= 0 {
		return errors.New("--quantity must be greater than zero")
	}
	parts, err := openComponents(*envFile, false)
	if err != nil {
		return err
	}
	defer parts.store.Close()
	ctx := context.Background()
	status, err := parts.orders.Status(ctx)
	if err != nil {
		return fmt.Errorf("verify POSApp order intake: %w", err)
	}
	if status["dispatch_policy"] != "hold_only" {
		return errors.New("POSApp order intake did not report the required hold_only dispatch policy")
	}
	pending, err := parts.store.ListPendingLimit(1)
	if err != nil {
		return err
	}
	locked, err := parts.store.ListHandoffLockedLimit(1)
	if err != nil {
		return err
	}
	if !parts.pos.IsLoopback() && !*allowRemote && (len(pending) > 0 || len(locked) > 0 || *recoverOnly) {
		return errors.New("remote recovery requires --allow-remote-submit")
	}
	recovered, err := parts.orders.RecoverPending(ctx)
	if err != nil {
		return err
	}
	if *recoverOnly {
		return printJSON(map[string]any{"recovered": recovered})
	}
	typesResponse, err := parts.orders.ListOrderTypes(ctx)
	if err != nil {
		return err
	}
	productsResponse, err := parts.orders.SearchCatalog(ctx, *query, 20)
	if err != nil {
		return err
	}
	orderType := selectRow(typesResponse["order_types"], *orderTypeID, false)
	product := selectRow(productsResponse["products"], *productID, true)
	if orderType == nil {
		return errors.New("no matching active order type was returned")
	}
	if product == nil {
		return errors.New("no matching simple product was returned; change --query or --product-id")
	}
	if *callID == "" {
		*callID, err = gateway.NewExternalRequestID()
		if err != nil {
			return err
		}
	}
	quoted, err := parts.orders.QuoteDraft(ctx, *callID, map[string]any{
		"order_type_id": intValue(orderType["id"]),
		"customer": map[string]any{
			"name": "Gemini Gateway Simulator", "phone": "0799999999", "address": "Local simulation - do not deliver",
		},
		"items":      []any{map[string]any{"product_id": intValue(product["id"]), "quantity": *quantity}},
		"order_note": "Go gateway deterministic simulation",
	})
	if err != nil {
		return err
	}
	result := map[string]any{
		"target": parts.config.POSBaseURL, "client_id": status["client_id"], "dispatch_policy": status["dispatch_policy"],
		"external_request_id": *callID, "selected_order_type": orderType,
		"selected_product": map[string]any{"id": product["id"], "name": product["name"], "quantity": *quantity},
		"quote":            quoted.Quote, "state": quoted.State, "recovered": recovered,
	}
	if *submit {
		if !parts.pos.IsLoopback() && !*allowRemote {
			return errors.New("remote submission requires --allow-remote-submit")
		}
		confirmed, err := parts.orders.ConfirmOrder(ctx, *callID, true)
		if err != nil {
			return err
		}
		result["result"] = confirmed
	}
	return printJSON(result)
}

func selectRow(value any, requestedID int, requireSimple bool) map[string]any {
	rows, _ := value.([]any)
	for _, value := range rows {
		row, _ := value.(map[string]any)
		if row == nil || requestedID > 0 && intValue(row["id"]) != requestedID {
			continue
		}
		if requireSimple && requestedID == 0 && hasRequiredModifiers(row) {
			continue
		}
		return row
	}
	return nil
}

func hasRequiredModifiers(product map[string]any) bool {
	groups, _ := product["modifiers"].([]any)
	for _, value := range groups {
		group, _ := value.(map[string]any)
		required, _ := group["required"].(bool)
		if required {
			return true
		}
	}
	return false
}

func intValue(value any) int {
	switch typed := value.(type) {
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	case float64:
		return int(typed)
	case int:
		return typed
	case int64:
		return int(typed)
	default:
		return 0
	}
}

func printJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func ensureLocalPOS(ctx context.Context, rawURL, configuredRoot string) (*managedProcess, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "http" || !config.IsLoopbackHostname(parsed.Hostname()) {
		return nil, errors.New("local mode requires a loopback HTTP ORDER_INTAKE_BASE_URL")
	}
	if posHealthy(parsed) {
		fmt.Printf("Using the POSApp server already running at %s.\n", parsed.String())
		return nil, nil
	}
	root, err := findRepoRoot(configuredRoot)
	if err != nil {
		return nil, err
	}
	port := parsed.Port()
	if port == "" {
		port = "80"
	}
	command := exec.Command("node", "server.js")
	command.Dir = root
	command.Env = replaceEnvironment(posProcessEnvironment(os.Environ()), "PORT", port)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.Stdin = os.Stdin
	command.SysProcAttr = hiddenProcessAttributes()
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start local POSApp: %w", err)
	}
	process := &managedProcess{command: command, done: make(chan error, 1)}
	go func() { process.done <- command.Wait() }()
	fmt.Printf("Starting local POSApp on port %s.\n", port)
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		if posHealthy(parsed) {
			return process, nil
		}
		select {
		case err := <-process.done:
			if err != nil {
				return nil, fmt.Errorf("POSApp stopped before it became ready: %w", err)
			}
			return nil, errors.New("POSApp stopped before it became ready")
		default:
		}
		timer := time.NewTimer(250 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			process.stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	process.stop()
	return nil, fmt.Errorf("POSApp did not become ready at %s within 25 seconds", parsed.String())
}

func posHealthy(base *url.URL) bool {
	health := base.ResolveReference(&url.URL{Path: "/api/health"})
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get(health.String())
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	var body struct {
		Success  bool   `json:"success"`
		Status   string `json:"status"`
		Database string `json:"database"`
	}
	return json.NewDecoder(response.Body).Decode(&body) == nil && body.Success && body.Status == "UP" && body.Database == "CONNECTED"
}

func findRepoRoot(configured string) (string, error) {
	if configured != "" {
		absolute, err := filepath.Abs(configured)
		if err != nil {
			return "", err
		}
		if fileExists(filepath.Join(absolute, "server.js")) {
			return absolute, nil
		}
		return "", errors.New("--repo-root does not contain server.js")
	}
	current, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if fileExists(filepath.Join(current, "server.js")) {
			return current, nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	return "", errors.New("could not find the POSApp repository root; pass --repo-root")
}

func fileExists(filename string) bool {
	info, err := os.Stat(filename)
	return err == nil && !info.IsDir()
}

func replaceEnvironment(environment []string, key, value string) []string {
	prefix := strings.ToUpper(key) + "="
	result := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		if !strings.HasPrefix(strings.ToUpper(entry), prefix) {
			result = append(result, entry)
		}
	}
	return append(result, key+"="+value)
}

func posProcessEnvironment(environment []string) []string {
	result := make([]string, 0, len(environment))
	for _, entry := range environment {
		key, _, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		upper := strings.ToUpper(key)
		if upper == "GEMINI_API_KEY" || upper == "GOOGLE_API_KEY" ||
			upper == "ORDER_INTAKE_API_KEY" || upper == "ORDER_INTAKE_BASE_URL" ||
			strings.HasPrefix(upper, "GEMINI_") || strings.HasPrefix(upper, "VOICE_GATEWAY_") ||
			strings.HasPrefix(upper, "ORDER_GATEWAY_") || strings.HasPrefix(upper, "UCM_SIP_") {
			continue
		}
		result = append(result, entry)
	}
	return result
}

func (process *managedProcess) stop() {
	if process == nil || process.command == nil || process.command.Process == nil || process.command.ProcessState != nil && process.command.ProcessState.Exited() {
		return
	}
	_ = process.command.Process.Kill()
	select {
	case <-process.done:
	case <-time.After(5 * time.Second):
	}
}

func errorCode(err error) string {
	var coded interface{ ErrorCode() string }
	if errors.As(err, &coded) && coded.ErrorCode() != "" {
		return coded.ErrorCode()
	}
	return "GATEWAY_ERROR"
}
