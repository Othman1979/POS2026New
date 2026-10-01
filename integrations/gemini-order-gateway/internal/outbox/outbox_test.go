package outbox

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

type testError struct{ code, message string }

func (e testError) Error() string     { return e.message }
func (e testError) ErrorCode() string { return e.code }

func TestOutboxPersistsExactConfirmedSubmissionAndRecovers(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "outbox.sqlite")
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	store, err := open(filename, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	draft := map[string]any{
		"external_request_id": "call-outbox-0001",
		"customer":            map[string]any{"name": "Customer", "phone": "0790000000"},
		"items":               []any{map[string]any{"product_id": 10, "quantity": 2}},
	}
	if _, err := store.SaveDraft(draft); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveQuote("call-outbox-0001", map[string]any{"quote_token": "secret-token", "total": 10}); err != nil {
		t.Fatal(err)
	}
	pending, err := store.MarkPending("call-outbox-0001")
	if err != nil {
		t.Fatal(err)
	}
	if pending.State != "pending" || pending.Submission["quote_token"] != "secret-token" || pending.Submission["confirmed"] != true {
		t.Fatalf("unexpected pending row: %#v", pending)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(filename)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	rows, err := reopened.ListPending()
	if err != nil || len(rows) != 1 {
		t.Fatalf("pending recovery failed: rows=%d err=%v", len(rows), err)
	}
	quantity := rows[0].Submission["draft"].(map[string]any)["items"].([]any)[0].(map[string]any)["quantity"].(json.Number)
	if quantity.String() != "2" {
		t.Fatalf("quantity changed: %s", quantity)
	}
}

func TestOutboxStateTransitionsFailClosed(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	draft := map[string]any{"external_request_id": "call-outbox-0002", "items": []any{}}
	if _, err := store.SaveDraft(draft); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkPending("call-outbox-0002"); err == nil {
		t.Fatal("draft without quote became pending")
	}
	if _, err := store.SaveQuote("call-outbox-0002", map[string]any{"quote_token": "token"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkPending("call-outbox-0002"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkBlocked("call-outbox-0002", testError{"AUTH", "denied"}); err != nil {
		t.Fatal(err)
	}
	row, _ := store.Get("call-outbox-0002")
	if row.State != "blocked" || row.LastErrorCode != "AUTH" {
		t.Fatalf("unexpected blocked row: %#v", row)
	}
	if _, err := store.SaveDraft(draft); err == nil {
		t.Fatal("blocked draft was mutated")
	}
	if _, err := store.MarkCompleted("call-outbox-0002", map[string]any{"id": 1}); err == nil {
		t.Fatal("blocked order was completed")
	}
}

func TestRecoveryListsAreBounded(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for index := 0; index < 5; index++ {
		id := fmt.Sprintf("call-batch-%04d", index)
		if _, err := store.SaveDraft(map[string]any{"external_request_id": id}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.SaveQuote(id, map[string]any{"quote_token": "token"}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.MarkPending(id); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := store.ListPendingLimit(2)
	if err != nil || len(rows) != 2 {
		t.Fatalf("bounded recovery returned %d rows: %v", len(rows), err)
	}
}
