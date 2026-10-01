package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	mathrand "math/rand/v2"
	"sync"
	"time"

	"posapp.local/gemini-order-gateway/internal/outbox"
	"posapp.local/gemini-order-gateway/internal/pos"
)

var requoteCodes = map[string]bool{
	"ORDER_INTAKE_REQUOTE_REQUIRED": true,
	"ORDER_INTAKE_QUOTE_EXPIRED":    true,
}

var correctableAvailabilityCodes = map[string]bool{
	"ORDER_INTAKE_PRODUCT_UNAVAILABLE":  true,
	"ORDER_INTAKE_MODIFIER_UNAVAILABLE": true,
	"ORDER_INTAKE_BUNDLE_UNAVAILABLE":   true,
	"ORDER_INTAKE_STOCK_UNAVAILABLE":    true,
}

const recoveryBatchSize = 50

type POSClient interface {
	Status(context.Context) (map[string]any, error)
	ListOrderTypes(context.Context) (map[string]any, error)
	SearchCatalog(context.Context, string, int) (map[string]any, error)
	BrowseCatalog(context.Context, *int, *int, int) (map[string]any, error)
	LookupCustomer(context.Context, string) (map[string]any, error)
	QuoteOrder(context.Context, map[string]any) (map[string]any, error)
	CreateHeldOrder(context.Context, map[string]any) (map[string]any, error)
	LookupRequest(context.Context, string) (map[string]any, error)
}

type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string     { return e.Message }
func (e *Error) ErrorCode() string { return e.Code }

type Outcome struct {
	ExternalRequestID  string         `json:"external_request_id"`
	State              string         `json:"state"`
	Quote              map[string]any `json:"quote"`
	HeldOrder          map[string]any `json:"held_order"`
	AttemptCount       int            `json:"attempt_count"`
	RequiresFreshQuote bool           `json:"requires_fresh_quote"`
	Failure            map[string]any `json:"error"`
}

func (o Outcome) Map() map[string]any {
	encoded, _ := json.Marshal(o)
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	result := map[string]any{}
	_ = decoder.Decode(&result)
	return result
}

type flight struct {
	done    chan struct{}
	outcome Outcome
	err     error
}

type Gateway struct {
	pos              POSClient
	outbox           *outbox.Store
	recoveryDelay    time.Duration
	delay            func(context.Context, time.Duration) error
	mu               sync.Mutex
	inFlight         map[string]*flight
	handoffRequested map[string]bool
}

func New(posClient POSClient, store *outbox.Store, recoveryDelay time.Duration) (*Gateway, error) {
	if posClient == nil || store == nil {
		return nil, errors.New("gateway requires a POS client and outbox")
	}
	return &Gateway{
		pos: posClient, outbox: store, recoveryDelay: recoveryDelay, inFlight: map[string]*flight{}, handoffRequested: map[string]bool{},
		delay: func(ctx context.Context, duration time.Duration) error {
			if duration <= 0 {
				return nil
			}
			timer := time.NewTimer(duration)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				return nil
			}
		},
	}, nil
}

func NewExternalRequestID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate call identity: %w", err)
	}
	hexID := hex.EncodeToString(bytes)
	return fmt.Sprintf("call-%d-%s-%s-%s-%s-%s", time.Now().UnixMilli(), hexID[:8], hexID[8:12], hexID[12:16], hexID[16:20], hexID[20:]), nil
}

func (g *Gateway) Status(ctx context.Context) (map[string]any, error) { return g.pos.Status(ctx) }
func (g *Gateway) ListOrderTypes(ctx context.Context) (map[string]any, error) {
	return g.pos.ListOrderTypes(ctx)
}
func (g *Gateway) SearchCatalog(ctx context.Context, query string, limit int) (map[string]any, error) {
	return g.pos.SearchCatalog(ctx, query, limit)
}
func (g *Gateway) BrowseCatalog(ctx context.Context, categoryID, cursor *int, limit int) (map[string]any, error) {
	return g.pos.BrowseCatalog(ctx, categoryID, cursor, limit)
}
func (g *Gateway) LookupCustomer(ctx context.Context, phone string) (map[string]any, error) {
	return g.pos.LookupCustomer(ctx, phone)
}

func (g *Gateway) GetOrder(externalRequestID string) (*Outcome, error) {
	row, err := g.outbox.Get(externalRequestID)
	if err != nil || row == nil {
		return nil, err
	}
	outcome := publicOutcome(row)
	return &outcome, nil
}

func (g *Gateway) QuoteDraft(ctx context.Context, externalRequestID string, input map[string]any) (Outcome, error) {
	draft := cloneMap(input)
	draft["external_request_id"] = externalRequestID
	if _, err := g.outbox.SaveDraft(draft); err != nil {
		return Outcome{}, err
	}
	quote, err := g.pos.QuoteOrder(ctx, draft)
	if err != nil {
		return Outcome{}, err
	}
	row, err := g.outbox.SaveQuote(externalRequestID, quote)
	if err != nil {
		return Outcome{}, err
	}
	return publicOutcome(row), nil
}

func (g *Gateway) ConfirmOrder(ctx context.Context, externalRequestID string, customerConfirmed bool) (Outcome, error) {
	if !customerConfirmed {
		return Outcome{}, &Error{Code: "ORDER_GATEWAY_CONFIRMATION_REQUIRED", Message: "Explicit customer confirmation is required before creating a held order."}
	}
	return g.exclusive(ctx, externalRequestID, func() (Outcome, error) {
		row, err := g.outbox.Require(externalRequestID)
		if err != nil {
			return Outcome{}, err
		}
		switch row.State {
		case "completed":
			return publicOutcome(row), nil
		case "handoff_locked":
			return Outcome{}, &Error{Code: "ORDER_GATEWAY_HANDOFF_LOCKED", Message: "This order is locked for staff handoff."}
		case "blocked":
			return Outcome{}, &Error{Code: "ORDER_GATEWAY_BLOCKED", Message: "This order needs manual review."}
		case "requote_required":
			if row.QuoteToken == "" {
				return Outcome{}, &Error{Code: "ORDER_GATEWAY_FRESH_QUOTE_REQUIRED", Message: "The previous quote expired. Request a fresh quote and ask the customer to confirm it."}
			}
		}
		if row.State != "pending" {
			row, err = g.outbox.MarkPending(externalRequestID)
			if err != nil {
				return Outcome{}, err
			}
		}
		return g.submitPending(ctx, row, 2)
	})
}

func (g *Gateway) RecoverPending(ctx context.Context) ([]Outcome, error) {
	result := []Outcome{}
	var recoveryErrors []error
	pending, err := g.outbox.ListPendingLimit(recoveryBatchSize)
	if err != nil {
		return nil, err
	}
	for _, row := range pending {
		outcome, err := g.exclusive(ctx, row.ExternalRequestID, func() (Outcome, error) {
			reconciled, found, blocked, unknown, err := g.reconcile(ctx, row.ExternalRequestID)
			if err != nil {
				return Outcome{}, err
			}
			if found || blocked || unknown {
				return reconciled, nil
			}
			current, err := g.outbox.Require(row.ExternalRequestID)
			if err != nil {
				return Outcome{}, err
			}
			return g.submitPending(ctx, current, 1)
		})
		if err != nil {
			recoveryErrors = append(recoveryErrors, fmt.Errorf("recover %s: %w", row.ExternalRequestID, err))
			continue
		}
		result = append(result, outcome)
	}
	locked, err := g.outbox.ListHandoffLockedLimit(recoveryBatchSize)
	if err != nil {
		return result, errors.Join(append(recoveryErrors, err)...)
	}
	for _, row := range locked {
		outcome, err := g.exclusive(ctx, row.ExternalRequestID, func() (Outcome, error) {
			reconciled, _, _, _, err := g.reconcile(ctx, row.ExternalRequestID)
			if err != nil {
				return Outcome{}, err
			}
			if reconciled.ExternalRequestID != "" {
				return reconciled, nil
			}
			current, err := g.outbox.Require(row.ExternalRequestID)
			if err != nil {
				return Outcome{}, err
			}
			return publicOutcome(current), nil
		})
		if err != nil {
			recoveryErrors = append(recoveryErrors, fmt.Errorf("reconcile %s: %w", row.ExternalRequestID, err))
			continue
		}
		result = append(result, outcome)
	}
	return result, errors.Join(recoveryErrors...)
}

func (g *Gateway) HandoffLock(externalRequestID string) (Outcome, error) {
	for {
		g.mu.Lock()
		g.handoffRequested[externalRequestID] = true
		if current := g.inFlight[externalRequestID]; current != nil {
			g.mu.Unlock()
			<-current.done
			continue
		}
		active := &flight{done: make(chan struct{})}
		g.inFlight[externalRequestID] = active
		g.mu.Unlock()

		row, err := g.outbox.Require(externalRequestID)
		if err == nil {
			switch row.State {
			case "pending":
				row, err = g.outbox.MarkHandoffLocked(externalRequestID)
			case "completed", "handoff_locked":
			default:
				err = fmt.Errorf("the %s order cannot be handed off", row.State)
			}
		}
		if err == nil {
			active.outcome = publicOutcome(row)
		} else {
			active.err = err
		}
		close(active.done)
		g.mu.Lock()
		delete(g.inFlight, externalRequestID)
		delete(g.handoffRequested, externalRequestID)
		g.mu.Unlock()
		return active.outcome, active.err
	}
}

func (g *Gateway) isHandoffRequested(externalRequestID string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.handoffRequested[externalRequestID]
}

func (g *Gateway) submitPending(ctx context.Context, row *outbox.Row, maxAttempts int) (Outcome, error) {
	var lastError error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if g.isHandoffRequested(row.ExternalRequestID) {
			current, err := g.outbox.Require(row.ExternalRequestID)
			if err != nil {
				return Outcome{}, err
			}
			return publicOutcome(current), nil
		}
		before, err := g.outbox.Require(row.ExternalRequestID)
		if err != nil {
			return Outcome{}, err
		}
		if before.State == "handoff_locked" {
			reconciled, _, _, _, err := g.reconcile(ctx, row.ExternalRequestID)
			if err != nil {
				return Outcome{}, err
			}
			if reconciled.ExternalRequestID != "" {
				return reconciled, nil
			}
			current, err := g.outbox.Require(row.ExternalRequestID)
			if err != nil {
				return Outcome{}, err
			}
			return publicOutcome(current), nil
		}
		if _, err := g.outbox.RecordAttempt(row.ExternalRequestID, lastError); err != nil {
			return Outcome{}, err
		}
		current, err := g.outbox.Require(row.ExternalRequestID)
		if err != nil {
			return Outcome{}, err
		}
		if g.isHandoffRequested(row.ExternalRequestID) {
			return publicOutcome(current), nil
		}
		response, createError := g.pos.CreateHeldOrder(ctx, current.Submission)
		if createError == nil {
			heldOrder, err := requireHeldOrder(response["held_order"], true)
			if err != nil {
				createError = err
			} else {
				completed, err := g.outbox.MarkCompleted(row.ExternalRequestID, heldOrder)
				if err != nil {
					return Outcome{}, err
				}
				return publicOutcome(completed), nil
			}
		}
		posError := new(pos.Error)
		if !errors.As(createError, &posError) {
			return Outcome{}, createError
		}
		lastError = posError
		if g.isHandoffRequested(row.ExternalRequestID) && ambiguousRetry(posError) {
			updated, err := g.outbox.RecordError(row.ExternalRequestID, posError)
			if err != nil {
				return Outcome{}, err
			}
			return publicOutcome(updated), nil
		}
		latest, err := g.outbox.Require(row.ExternalRequestID)
		if err != nil {
			return Outcome{}, err
		}
		if latest.State == "handoff_locked" {
			if _, err := g.outbox.RecordError(row.ExternalRequestID, posError); err != nil {
				return Outcome{}, err
			}
			if err := g.delay(ctx, g.retryDelay(current.AttemptCount)); err != nil {
				return Outcome{}, err
			}
			reconciled, _, _, _, err := g.reconcile(ctx, row.ExternalRequestID)
			if err != nil {
				return Outcome{}, err
			}
			if reconciled.ExternalRequestID != "" {
				return reconciled, nil
			}
			current, _ := g.outbox.Require(row.ExternalRequestID)
			return publicOutcome(current), nil
		}
		correctableAvailability := posError.Status == 409 && !posError.Ambiguous && !posError.Retryable && correctableAvailabilityCodes[posError.Code]
		if requoteCodes[posError.Code] || correctableAvailability {
			var quote map[string]any
			if posError.Payload != nil {
				quote, _ = posError.Payload["quote"].(map[string]any)
			}
			requoted, err := g.outbox.MarkRequoteRequired(row.ExternalRequestID, quote, posError)
			if err != nil {
				return Outcome{}, err
			}
			return publicOutcome(requoted), nil
		}
		if !ambiguousRetry(posError) {
			blocked, err := g.outbox.MarkBlocked(row.ExternalRequestID, posError)
			if err != nil {
				return Outcome{}, err
			}
			return publicOutcome(blocked), nil
		}
		if _, err := g.outbox.RecordError(row.ExternalRequestID, posError); err != nil {
			return Outcome{}, err
		}
		if err := g.delay(ctx, g.retryDelay(current.AttemptCount)); err != nil {
			return Outcome{}, err
		}
		reconciled, found, blocked, unknown, err := g.reconcile(ctx, row.ExternalRequestID)
		if err != nil {
			return Outcome{}, err
		}
		if found || blocked || unknown {
			return reconciled, nil
		}
		latest, _ = g.outbox.Require(row.ExternalRequestID)
		if latest.State == "handoff_locked" {
			return publicOutcome(latest), nil
		}
	}
	current, err := g.outbox.Require(row.ExternalRequestID)
	if err != nil {
		return Outcome{}, err
	}
	return publicOutcome(current), nil
}

func (g *Gateway) retryDelay(attemptCount int) time.Duration {
	if g.recoveryDelay <= 0 {
		return 0
	}
	delay := g.recoveryDelay
	for step := 1; step < attemptCount && delay < 10*time.Second; step++ {
		delay *= 2
	}
	if delay > 10*time.Second {
		delay = 10 * time.Second
	}
	jittered := time.Duration(float64(delay) * (0.75 + mathrand.Float64()*0.5))
	if jittered > 10*time.Second {
		return 10 * time.Second
	}
	return jittered
}

func (g *Gateway) reconcile(ctx context.Context, externalRequestID string) (Outcome, bool, bool, bool, error) {
	response, err := g.pos.LookupRequest(ctx, externalRequestID)
	if err == nil {
		value, exists := response["request"]
		if !exists {
			return Outcome{}, false, false, false, invalidPOSResponse("POSApp returned an invalid request-lookup result.", false)
		}
		if value == nil {
			return Outcome{}, false, false, false, nil
		}
		heldOrder, err := requireHeldOrder(value, false)
		if err != nil {
			return Outcome{}, false, false, false, err
		}
		completed, err := g.outbox.MarkCompleted(externalRequestID, heldOrder)
		if err != nil {
			return Outcome{}, false, false, false, err
		}
		return publicOutcome(completed), true, false, false, nil
	}
	posError := new(pos.Error)
	if !errors.As(err, &posError) {
		return Outcome{}, false, false, false, err
	}
	current, requireErr := g.outbox.Require(externalRequestID)
	if requireErr != nil {
		return Outcome{}, false, false, false, requireErr
	}
	if !ambiguousRetry(posError) {
		if current.State == "handoff_locked" {
			updated, recordErr := g.outbox.RecordError(externalRequestID, posError)
			if recordErr != nil {
				return Outcome{}, false, false, false, recordErr
			}
			return publicOutcome(updated), false, true, false, nil
		}
		blockedRow, blockErr := g.outbox.MarkBlocked(externalRequestID, posError)
		if blockErr != nil {
			return Outcome{}, false, false, false, blockErr
		}
		return publicOutcome(blockedRow), false, true, false, nil
	}
	if current.State == "handoff_locked" {
		if _, recordErr := g.outbox.RecordError(externalRequestID, posError); recordErr != nil {
			return Outcome{}, false, false, false, recordErr
		}
	}
	current, _ = g.outbox.Require(externalRequestID)
	return publicOutcome(current), false, false, true, nil
}

func (g *Gateway) exclusive(ctx context.Context, externalRequestID string, operation func() (Outcome, error)) (Outcome, error) {
	g.mu.Lock()
	if active := g.inFlight[externalRequestID]; active != nil {
		g.mu.Unlock()
		select {
		case <-ctx.Done():
			return Outcome{}, ctx.Err()
		case <-active.done:
			return active.outcome, active.err
		}
	}
	active := &flight{done: make(chan struct{})}
	g.inFlight[externalRequestID] = active
	g.mu.Unlock()
	active.outcome, active.err = operation()
	close(active.done)
	g.mu.Lock()
	delete(g.inFlight, externalRequestID)
	g.mu.Unlock()
	return active.outcome, active.err
}

func publicOutcome(row *outbox.Row) Outcome {
	quote := cloneMap(row.Quote)
	delete(quote, "quote_token")
	var failure map[string]any
	if row.LastErrorCode != "" {
		failure = map[string]any{"code": row.LastErrorCode, "message": row.LastErrorMessage}
	}
	return Outcome{
		ExternalRequestID: row.ExternalRequestID, State: row.State, Quote: quote, HeldOrder: cloneMap(row.Result),
		AttemptCount: row.AttemptCount, RequiresFreshQuote: row.State == "requote_required" && row.QuoteToken == "", Failure: failure,
	}
}

func requireHeldOrder(value any, ambiguous bool) (map[string]any, error) {
	heldOrder, ok := value.(map[string]any)
	if !ok || !validPositiveID(heldOrder["id"]) {
		return nil, invalidPOSResponse("POSApp returned an invalid held-order result.", ambiguous)
	}
	return heldOrder, nil
}

func invalidPOSResponse(message string, ambiguous bool) error {
	return &pos.Error{Code: "POS_INVALID_RESPONSE", Message: message, Retryable: true, Ambiguous: ambiguous}
}

func ambiguousRetry(err *pos.Error) bool { return err.Retryable || err.Ambiguous }

func validPositiveID(value any) bool {
	switch typed := value.(type) {
	case json.Number:
		integer, err := typed.Int64()
		return err == nil && integer > 0
	case int:
		return typed > 0
	case int64:
		return typed > 0
	case float64:
		return typed > 0 && typed == float64(int64(typed))
	default:
		return false
	}
}

func cloneMap(source map[string]any) map[string]any {
	if source == nil {
		return nil
	}
	result := make(map[string]any, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}
