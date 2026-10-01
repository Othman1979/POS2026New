package pos

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"posapp.local/gemini-order-gateway/internal/config"
)

const maxResponseBytes = 2 * 1024 * 1024

type Error struct {
	Status    int
	Code      string
	Message   string
	Payload   map[string]any
	Retryable bool
	Ambiguous bool
	Cause     error
}

func (e *Error) Error() string     { return e.Message }
func (e *Error) Unwrap() error     { return e.Cause }
func (e *Error) ErrorCode() string { return e.Code }
func (e *Error) IsRetryable() bool { return e.Retryable }

type Client struct {
	origin  *url.URL
	apiBase *url.URL
	apiKey  string
	timeout time.Duration
	http    *http.Client
}

func NewClient(baseURL, apiKey string, timeout time.Duration, httpClient *http.Client) (*Client, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("POS base URL must be absolute")
	}
	if parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, errors.New("POS base URL must be HTTP(S) without credentials")
	}
	if parsed.Scheme != "https" && !config.IsLoopbackHostname(parsed.Hostname()) {
		return nil, errors.New("remote POSApp connections require HTTPS")
	}
	apiKey = strings.TrimSpace(apiKey)
	if len(apiKey) < 32 {
		return nil, errors.New("a valid order-intake Bearer key is required")
	}
	if httpClient == nil {
		httpClient = &http.Client{Transport: &http.Transport{
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 32,
			IdleConnTimeout:     90 * time.Second,
		}}
	}
	clientCopy := *httpClient
	clientCopy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	origin := &url.URL{Scheme: parsed.Scheme, Host: parsed.Host}
	apiBase := origin.ResolveReference(&url.URL{Path: "/api/order-intake/v1/"})
	return &Client{origin: origin, apiBase: apiBase, apiKey: apiKey, timeout: timeout, http: &clientCopy}, nil
}

func (c *Client) IsLoopback() bool { return config.IsLoopbackHostname(c.origin.Hostname()) }

func (c *Client) Request(ctx context.Context, method, relativePath string, body any, ambiguous bool) (map[string]any, error) {
	if relativePath == "" || strings.Contains(relativePath, "\\") || strings.HasPrefix(relativePath, "//") {
		return nil, errors.New("POS request paths must be relative to the configured intake API")
	}
	reference, err := url.Parse(relativePath)
	if err != nil || reference.IsAbs() || reference.Host != "" {
		return nil, errors.New("POS request paths must be relative to the configured intake API")
	}
	target := c.apiBase.ResolveReference(reference)
	if target.Scheme != c.apiBase.Scheme || target.Host != c.apiBase.Host || !strings.HasPrefix(target.Path, c.apiBase.Path) {
		return nil, errors.New("POS request path escaped the configured intake API")
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode POS request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	requestCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, method, target.String(), reader)
	if err != nil {
		return nil, fmt.Errorf("create POS request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+c.apiKey)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		code := "POS_NETWORK_ERROR"
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(requestCtx.Err(), context.DeadlineExceeded) {
			code = "POS_REQUEST_TIMEOUT"
		}
		return nil, &Error{
			Code: code, Message: "POSApp could not be reached or did not respond in time.",
			Retryable: true, Ambiguous: ambiguous, Cause: err,
		}
	}
	defer response.Body.Close()
	if response.ContentLength > maxResponseBytes {
		return nil, &Error{
			Status: response.StatusCode, Code: "POS_RESPONSE_TOO_LARGE",
			Message: "POSApp returned an oversized response.", Retryable: responseIsRetryable(response.StatusCode), Ambiguous: ambiguous,
		}
	}
	limited := io.LimitReader(response.Body, maxResponseBytes+1)
	payloadBytes, err := io.ReadAll(limited)
	if err != nil {
		return nil, &Error{
			Status: response.StatusCode, Code: "POS_NETWORK_ERROR",
			Message: "POSApp response could not be read.", Retryable: true, Ambiguous: ambiguous, Cause: err,
		}
	}
	if len(payloadBytes) > maxResponseBytes {
		return nil, &Error{
			Status: response.StatusCode, Code: "POS_RESPONSE_TOO_LARGE",
			Message: "POSApp returned an oversized response.", Retryable: responseIsRetryable(response.StatusCode), Ambiguous: ambiguous,
		}
	}
	payload := map[string]any{}
	if len(payloadBytes) > 0 {
		decoder := json.NewDecoder(bytes.NewReader(payloadBytes))
		decoder.UseNumber()
		if err := decoder.Decode(&payload); err != nil {
			return nil, &Error{
				Status: response.StatusCode, Code: "POS_NON_JSON_RESPONSE",
				Message: "POSApp returned a non-JSON response.", Retryable: responseIsRetryable(response.StatusCode), Ambiguous: ambiguous,
			}
		}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := payload["message"].(string)
		if message == "" {
			message = fmt.Sprintf("POSApp rejected the request with HTTP %d.", response.StatusCode)
		}
		code, _ := payload["code"].(string)
		if code == "" {
			code = "POS_REQUEST_REJECTED"
		}
		retryable := responseIsRetryable(response.StatusCode)
		return nil, &Error{
			Status: response.StatusCode, Code: code, Message: message, Payload: payload,
			Retryable: retryable, Ambiguous: ambiguous && retryable,
		}
	}
	return payload, nil
}

func (c *Client) Status(ctx context.Context) (map[string]any, error) {
	return c.Request(ctx, http.MethodGet, "status", nil, false)
}

func (c *Client) ListOrderTypes(ctx context.Context) (map[string]any, error) {
	return c.Request(ctx, http.MethodGet, "order-types", nil, false)
}

func (c *Client) SearchCatalog(ctx context.Context, query string, limit int) (map[string]any, error) {
	params := url.Values{"q": {query}, "limit": {fmt.Sprintf("%d", limit)}}
	return c.Request(ctx, http.MethodGet, "catalog/search?"+params.Encode(), nil, false)
}

func (c *Client) BrowseCatalog(ctx context.Context, categoryID, cursor *int, limit int) (map[string]any, error) {
	params := url.Values{"limit": {fmt.Sprintf("%d", limit)}}
	if categoryID != nil {
		params.Set("category_id", fmt.Sprintf("%d", *categoryID))
	}
	if cursor != nil {
		params.Set("cursor", fmt.Sprintf("%d", *cursor))
	}
	return c.Request(ctx, http.MethodGet, "catalog/browse?"+params.Encode(), nil, false)
}

func (c *Client) LookupCustomer(ctx context.Context, phone string) (map[string]any, error) {
	return c.Request(ctx, http.MethodPost, "customers/lookup", map[string]any{"phone": phone}, false)
}

func (c *Client) QuoteOrder(ctx context.Context, draft map[string]any) (map[string]any, error) {
	return c.Request(ctx, http.MethodPost, "quotes", draft, false)
}

func (c *Client) CreateHeldOrder(ctx context.Context, submission map[string]any) (map[string]any, error) {
	return c.Request(ctx, http.MethodPost, "held-orders", submission, true)
}

func (c *Client) LookupRequest(ctx context.Context, externalRequestID string) (map[string]any, error) {
	return c.Request(ctx, http.MethodGet, "requests/"+url.PathEscape(externalRequestID), nil, false)
}

func responseIsRetryable(status int) bool {
	return status == http.StatusRequestTimeout || status == http.StatusTooEarly || status == http.StatusTooManyRequests || status >= 500
}
