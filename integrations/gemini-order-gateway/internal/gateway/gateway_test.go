package gateway

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"posapp.local/gemini-order-gateway/internal/outbox"
	"posapp.local/gemini-order-gateway/internal/pos"
)

type fakePOS struct {
	mu      sync.Mutex
	creates int
	create  func(map[string]any) (map[string]any, error)
	lookup  func(string) (map[string]any, error)
}

func (f *fakePOS) Status(context.Context) (map[string]any, error) {
	return map[string]any{"success": true}, nil
}
func (f *fakePOS) ListOrderTypes(context.Context) (map[string]any, error) {
	return map[string]any{"order_types": []any{}}, nil
}
func (f *fakePOS) SearchCatalog(context.Context, string, int) (map[string]any, error) {
	return nil, nil
}
func (f *fakePOS) BrowseCatalog(context.Context, *int, *int, int) (map[string]any, error) {
	return nil, nil
}
func (f *fakePOS) LookupCustomer(context.Context, string) (map[string]any, error) { return nil, nil }
func (f *fakePOS) QuoteOrder(context.Context, map[string]any) (map[string]any, error) {
	return map[string]any{"quote_token": "signed", "total": json.Number("5")}, nil
}
func (f *fakePOS) CreateHeldOrder(_ context.Context, submission map[string]any) (map[string]any, error) {
	f.mu.Lock()
	f.creates++
	f.mu.Unlock()
	return f.create(submission)
}
func (f *fakePOS) LookupRequest(_ context.Context, id string) (map[string]any, error) {
	return f.lookup(id)
}

func harness(t *testing.T, fake *fakePOS) (*Gateway, *outbox.Store) {
	t.Helper()
	store, err := outbox.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	gateway, err := New(fake, store, 0)
	if err != nil {
		t.Fatal(err)
	}
	return gateway, store
}

func quoteDraft(t *testing.T, gateway *Gateway, id string) {
	t.Helper()
	_, err := gateway.QuoteDraft(context.Background(), id, map[string]any{
		"order_type_id": 1,
		"customer":      map[string]any{"name": "Test", "phone": "0790000000", "address": "Amman"},
		"items":         []any{map[string]any{"product_id": 10, "quantity": 1}},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestConfirmPersistsAndCoalescesOneCreate(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	fake := &fakePOS{
		create: func(map[string]any) (map[string]any, error) {
			close(started)
			<-release
			return map[string]any{"held_order": map[string]any{"id": json.Number("91")}}, nil
		},
		lookup: func(string) (map[string]any, error) { return map[string]any{"request": nil}, nil },
	}
	gateway, store := harness(t, fake)
	defer store.Close()
	quoteDraft(t, gateway, "call-concurrent-0001")
	results := make(chan Outcome, 2)
	errors := make(chan error, 2)
	go func() {
		r, e := gateway.ConfirmOrder(context.Background(), "call-concurrent-0001", true)
		results <- r
		errors <- e
	}()
	<-started
	go func() {
		r, e := gateway.ConfirmOrder(context.Background(), "call-concurrent-0001", true)
		results <- r
		errors <- e
	}()
	close(release)
	for i := 0; i < 2; i++ {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
		if result := <-results; result.State != "completed" {
			t.Fatalf("unexpected outcome: %#v", result)
		}
	}
	if fake.creates != 1 {
		t.Fatalf("created %d orders", fake.creates)
	}
	row, _ := store.Get("call-concurrent-0001")
	if row.Submission["quote_token"] != "signed" || row.Submission["confirmed"] != true {
		t.Fatalf("submission was not persisted: %#v", row.Submission)
	}
}

func TestLostCreateResponseReconcilesBeforeReplay(t *testing.T) {
	fake := &fakePOS{}
	fake.create = func(map[string]any) (map[string]any, error) {
		return nil, &pos.Error{Code: "POS_REQUEST_TIMEOUT", Message: "lost", Retryable: true, Ambiguous: true}
	}
	fake.lookup = func(string) (map[string]any, error) {
		return map[string]any{"request": map[string]any{"id": json.Number("92"), "replay": true}}, nil
	}
	gateway, store := harness(t, fake)
	defer store.Close()
	quoteDraft(t, gateway, "call-lost-0001")
	result, err := gateway.ConfirmOrder(context.Background(), "call-lost-0001", true)
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "completed" || fake.creates != 1 {
		t.Fatalf("unexpected result: %#v creates=%d", result, fake.creates)
	}
}

func TestRequoteRequiresAnotherConfirmation(t *testing.T) {
	fake := &fakePOS{
		create: func(map[string]any) (map[string]any, error) {
			return nil, &pos.Error{Code: "ORDER_INTAKE_REQUOTE_REQUIRED", Message: "changed", Status: 409, Payload: map[string]any{"quote": map[string]any{"quote_token": "replacement", "total": json.Number("6")}}}
		},
		lookup: func(string) (map[string]any, error) { return map[string]any{"request": nil}, nil },
	}
	gateway, store := harness(t, fake)
	defer store.Close()
	quoteDraft(t, gateway, "call-requote-0001")
	result, err := gateway.ConfirmOrder(context.Background(), "call-requote-0001", true)
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "requote_required" || result.Quote["quote_token"] != nil {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestStartupRecoveryReplaysExactPendingSubmission(t *testing.T) {
	fake := &fakePOS{
		create: func(submission map[string]any) (map[string]any, error) {
			if submission["quote_token"] != "signed" || submission["confirmed"] != true {
				t.Fatalf("recovery changed durable submission: %#v", submission)
			}
			return map[string]any{"held_order": map[string]any{"id": json.Number("93")}}, nil
		},
		lookup: func(string) (map[string]any, error) { return map[string]any{"request": nil}, nil },
	}
	gateway, store := harness(t, fake)
	defer store.Close()
	quoteDraft(t, gateway, "call-recovery-0001")
	if _, err := store.MarkPending("call-recovery-0001"); err != nil {
		t.Fatal(err)
	}
	outcomes, err := gateway.RecoverPending(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(outcomes) != 1 || outcomes[0].State != "completed" || fake.creates != 1 {
		t.Fatalf("unexpected recovery: %#v creates=%d", outcomes, fake.creates)
	}
}

func TestRecoveryContinuesPastOneFailingRow(t *testing.T) {
	fake := &fakePOS{
		create: func(map[string]any) (map[string]any, error) {
			return map[string]any{"held_order": map[string]any{"id": json.Number("95")}}, nil
		},
		lookup: func(id string) (map[string]any, error) {
			if id == "call-recovery-bad-0001" {
				return map[string]any{}, nil
			}
			return map[string]any{"request": nil}, nil
		},
	}
	gateway, store := harness(t, fake)
	defer store.Close()
	for _, id := range []string{"call-recovery-bad-0001", "call-recovery-good-0001"} {
		quoteDraft(t, gateway, id)
		if _, err := store.MarkPending(id); err != nil {
			t.Fatal(err)
		}
	}
	outcomes, err := gateway.RecoverPending(context.Background())
	if err == nil || len(outcomes) != 1 || outcomes[0].ExternalRequestID != "call-recovery-good-0001" || outcomes[0].State != "completed" {
		t.Fatalf("bad row starved recovery: outcomes=%#v error=%v", outcomes, err)
	}
	if fake.creates != 1 {
		t.Fatalf("valid row was created %d times", fake.creates)
	}
}

func TestRecoveryNeverResubmitsHandoffLockedOrder(t *testing.T) {
	fake := &fakePOS{
		create: func(map[string]any) (map[string]any, error) {
			return map[string]any{"held_order": map[string]any{"id": json.Number("94")}}, nil
		},
		lookup: func(string) (map[string]any, error) { return map[string]any{"request": nil}, nil },
	}
	gateway, store := harness(t, fake)
	defer store.Close()
	quoteDraft(t, gateway, "call-handoff-0001")
	if _, err := store.MarkPending("call-handoff-0001"); err != nil {
		t.Fatal(err)
	}
	if _, err := gateway.HandoffLock("call-handoff-0001"); err != nil {
		t.Fatal(err)
	}
	outcomes, err := gateway.RecoverPending(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(outcomes) != 1 || outcomes[0].State != "handoff_locked" || fake.creates != 0 {
		t.Fatalf("handoff lock was resubmitted: %#v creates=%d", outcomes, fake.creates)
	}
}

func TestHandoffWaitsForInflightCreateAndStopsAmbiguousRetry(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	fake := &fakePOS{
		create: func(map[string]any) (map[string]any, error) {
			close(started)
			<-release
			return nil, &pos.Error{Code: "POS_REQUEST_TIMEOUT", Message: "lost", Retryable: true, Ambiguous: true}
		},
		lookup: func(string) (map[string]any, error) { return map[string]any{"request": nil}, nil },
	}
	gateway, store := harness(t, fake)
	defer store.Close()
	const id = "call-handoff-race-0001"
	quoteDraft(t, gateway, id)
	confirmed := make(chan Outcome, 1)
	confirmErrors := make(chan error, 1)
	go func() {
		result, err := gateway.ConfirmOrder(context.Background(), id, true)
		confirmed <- result
		confirmErrors <- err
	}()
	<-started
	locked := make(chan Outcome, 1)
	lockErrors := make(chan error, 1)
	go func() {
		result, err := gateway.HandoffLock(id)
		locked <- result
		lockErrors <- err
	}()
	deadline := time.Now().Add(time.Second)
	for !gateway.isHandoffRequested(id) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !gateway.isHandoffRequested(id) {
		close(release)
		t.Fatal("handoff request did not reach the in-flight create")
	}
	select {
	case <-locked:
		close(release)
		t.Fatal("handoff returned before the in-flight HTTP attempt settled")
	default:
	}
	close(release)
	if err := <-confirmErrors; err != nil {
		t.Fatal(err)
	}
	if result := <-confirmed; result.State != "pending" {
		t.Fatalf("unexpected in-flight result: %#v", result)
	}
	if err := <-lockErrors; err != nil {
		t.Fatal(err)
	}
	if result := <-locked; result.State != "handoff_locked" {
		t.Fatalf("unexpected handoff state: %#v", result)
	}
	if fake.creates != 1 {
		t.Fatalf("handoff allowed %d create attempts", fake.creates)
	}
}

func TestHandoffReportsCompletedWhenInflightCreateCommits(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	fake := &fakePOS{
		create: func(map[string]any) (map[string]any, error) {
			close(started)
			<-release
			return map[string]any{"held_order": map[string]any{"id": json.Number("96")}}, nil
		},
		lookup: func(string) (map[string]any, error) { return map[string]any{"request": nil}, nil },
	}
	gateway, store := harness(t, fake)
	defer store.Close()
	const id = "call-handoff-commit-0001"
	quoteDraft(t, gateway, id)
	confirmDone := make(chan struct{})
	go func() {
		_, _ = gateway.ConfirmOrder(context.Background(), id, true)
		close(confirmDone)
	}()
	<-started
	handoffDone := make(chan Outcome, 1)
	go func() {
		outcome, _ := gateway.HandoffLock(id)
		handoffDone <- outcome
	}()
	close(release)
	<-confirmDone
	select {
	case outcome := <-handoffDone:
		if outcome.State != "completed" || fake.creates != 1 {
			t.Fatalf("handoff obscured committed order: %#v creates=%d", outcome, fake.creates)
		}
	case <-time.After(time.Second):
		t.Fatal("handoff did not finish after the create committed")
	}
}

func TestGatewayRetryBackoffIsBounded(t *testing.T) {
	gateway := &Gateway{recoveryDelay: 250 * time.Millisecond}
	for sample := 0; sample < 100; sample++ {
		first := gateway.retryDelay(1)
		second := gateway.retryDelay(2)
		late := gateway.retryDelay(100)
		if first < 187*time.Millisecond || first > 313*time.Millisecond ||
			second < 375*time.Millisecond || second > 625*time.Millisecond ||
			late < 0 || late > 10*time.Second {
			t.Fatalf("unbounded retry delays: first=%s second=%s late=%s", first, second, late)
		}
	}
}

func TestExternalRequestIDsAreSafeAndUnique(t *testing.T) {
	first, err := NewExternalRequestID()
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Millisecond)
	second, err := NewExternalRequestID()
	if err != nil {
		t.Fatal(err)
	}
	if first == second || len(first) < 8 || len(first) > 128 {
		t.Fatalf("invalid ids: %q %q", first, second)
	}
}

func TestDefinitiveUnavailableItemCanBeRequotedWithoutReusingConfirmation(t *testing.T) {
	attempt := 0
	fake := &fakePOS{create: func(map[string]any) (map[string]any, error) {
		attempt++
		if attempt == 1 {
			return nil, &pos.Error{Status: 409, Code: "ORDER_INTAKE_PRODUCT_UNAVAILABLE", Message: "Item 1 is unavailable."}
		}
		return map[string]any{"held_order": map[string]any{"id": 99}}, nil
	}, lookup: func(string) (map[string]any, error) { return map[string]any{"request": nil}, nil }}
	gateway, store := harness(t, fake)
	defer store.Close()
	const id = "call-unavailable-0001"
	quoteDraft(t, gateway, id)
	result, err := gateway.ConfirmOrder(context.Background(), id, true)
	if err != nil || result.State != "requote_required" || !result.RequiresFreshQuote {
		t.Fatalf("availability rejection: %#v %v", result, err)
	}
	row, err := store.Require(id)
	if err != nil || row.State != "requote_required" || row.QuoteToken != "" || len(row.Submission) != 0 || row.LastErrorCode != "ORDER_INTAKE_PRODUCT_UNAVAILABLE" {
		t.Fatalf("unsafe correction state: %#v %v", row, err)
	}
	if _, err := gateway.ConfirmOrder(context.Background(), id, true); err == nil {
		t.Fatal("old confirmation reused without a fresh quote")
	}
	quoteDraft(t, gateway, id)
	result, err = gateway.ConfirmOrder(context.Background(), id, true)
	if err != nil || result.State != "completed" || attempt != 2 {
		t.Fatalf("correction failed: %#v %v", result, err)
	}
}

func TestOutcomeMapKeepsStableNullableFields(t *testing.T) {
	result := (Outcome{ExternalRequestID: "call-shape-0001", State: "draft"}).Map()
	for _, key := range []string{"quote", "held_order", "error"} {
		value, exists := result[key]
		if !exists || value != nil {
			t.Fatalf("outcome field %s was not a stable null: %#v", key, result)
		}
	}
}
