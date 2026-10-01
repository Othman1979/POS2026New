package tools

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"posapp.local/gemini-order-gateway/internal/gateway"
)

type fakeGateway struct {
	confirmed         int
	quoted            map[string]any
	confirmContextErr error
}

type requoteGateway struct {
	fakeGateway
	confirmations int
}

func (g *requoteGateway) ConfirmOrder(context.Context, string, bool) (gateway.Outcome, error) {
	g.confirmations++
	if g.confirmations == 1 {
		return gateway.Outcome{ExternalRequestID: "call-requote-tools", State: "requote_required", Quote: map[string]any{"total": 6}}, nil
	}
	return gateway.Outcome{ExternalRequestID: "call-requote-tools", State: "completed"}, nil
}

func (f *fakeGateway) ListOrderTypes(context.Context) (map[string]any, error) {
	return map[string]any{"order_types": []any{}}, nil
}
func (f *fakeGateway) SearchCatalog(context.Context, string, int) (map[string]any, error) {
	return map[string]any{"products": []any{map[string]any{
		"id": json.Number("10"), "name": "Burger", "category": "Food", "unit_price": json.Number("5"),
		"stock": 100, "tax_rate": 16, "modifiers": []any{}, "bundle_items": []any{}, "customer_info": "Served with garlic sauce",
	}}}, nil
}
func (f *fakeGateway) BrowseCatalog(context.Context, *int, *int, int) (map[string]any, error) {
	return map[string]any{
		"view": "products",
		"products": []any{map[string]any{
			"id": json.Number("9"), "name": "Fries", "category": "Sides", "unit_price": json.Number("2"), "stock": 50,
		}},
		"next_cursor": json.Number("9"),
	}, nil
}
func (f *fakeGateway) LookupCustomer(context.Context, string) (map[string]any, error) {
	return map[string]any{"customer": map[string]any{"id": 77, "name": "Customer", "address": "Amman"}}, nil
}
func (f *fakeGateway) QuoteDraft(_ context.Context, id string, args map[string]any) (gateway.Outcome, error) {
	f.quoted = map[string]any{"id": id, "args": args}
	return gateway.Outcome{ExternalRequestID: id, State: "quoted", Quote: map[string]any{"total": 5}}, nil
}
func (f *fakeGateway) ConfirmOrder(ctx context.Context, id string, confirmed bool) (gateway.Outcome, error) {
	f.confirmed++
	f.confirmContextErr = ctx.Err()
	return gateway.Outcome{ExternalRequestID: id, State: "completed"}, nil
}
func (f *fakeGateway) GetOrder(string) (*gateway.Outcome, error) { return nil, nil }

func TestExecutorProjectsPrivateFieldsAndGatesConfirmation(t *testing.T) {
	fake := &fakeGateway{}
	executor, err := NewExecutor(fake, "call-tool-0001", context.Background())
	if err != nil {
		t.Fatal(err)
	}
	discovery := executor.Execute(context.Background(), "browse_catalog", map[string]any{"category_id": 2})
	product := discovery["products"].([]any)[0].(map[string]any)
	if _, exists := product["stock"]; exists {
		t.Fatal("browse exposed stock")
	}
	search := executor.Execute(context.Background(), "search_catalog", map[string]any{"query": "burger"})
	searchProduct := search["products"].([]any)[0].(map[string]any)
	if searchProduct["customer_info"] != "Served with garlic sauce" {
		t.Fatal("customer information was lost")
	}
	if _, exists := searchProduct["tax_rate"]; exists {
		t.Fatal("search exposed tax")
	}
	executor.Execute(context.Background(), "quote_order", map[string]any{"order_type_id": 1, "customer": map[string]any{}, "items": []any{}})
	premature := executor.Execute(context.Background(), "confirm_order", map[string]any{"customer_confirmed": true})
	if premature["error"].(map[string]any)["code"] != "ORDER_GATEWAY_CONFIRMATION_TURN_REQUIRED" || fake.confirmed != 0 {
		t.Fatalf("premature confirmation passed: %#v", premature)
	}
	executor.NoteCustomerTurn()
	confirmed := executor.Execute(context.Background(), "confirm_order", map[string]any{"customer_confirmed": true})
	if confirmed["state"] != "completed" || fake.confirmed != 1 {
		t.Fatalf("confirmation failed: %#v", confirmed)
	}
}

func TestQuotePreservesSeparateItemAndDeliveryNotes(t *testing.T) {
	fake := &fakeGateway{}
	executor, err := NewExecutor(fake, "call-notes-0001", context.Background())
	if err != nil {
		t.Fatal(err)
	}
	draft := map[string]any{
		"order_type_id": 1,
		"customer":      map[string]any{"name": "Test", "phone": "0790000000", "address": "Amman"},
		"order_note":    "Call at the entrance",
		"items": []any{
			map[string]any{"product_id": 10, "quantity": 1, "note": "بدون بصل"},
			map[string]any{"product_id": 10, "quantity": 1, "note": "بدون ثوم"},
		},
	}
	executor.Execute(context.Background(), "quote_order", draft)
	if !reflect.DeepEqual(fake.quoted["args"], draft) {
		t.Fatalf("notes changed: %#v", fake.quoted)
	}
}

func TestExecutorUsesProcessContextForConfirmedDelivery(t *testing.T) {
	fake := &fakeGateway{}
	durableContext := context.Background()
	executor, err := NewExecutor(fake, "call-durable-0001", durableContext)
	if err != nil {
		t.Fatal(err)
	}
	executor.Execute(context.Background(), "quote_order", map[string]any{})
	executor.NoteCustomerTurn()
	mediaContext, cancel := context.WithCancel(context.Background())
	cancel()
	result := executor.Execute(mediaContext, "confirm_order", map[string]any{"customer_confirmed": true})
	if result["state"] != "completed" || fake.confirmContextErr != nil {
		t.Fatalf("confirmed delivery inherited media cancellation: result=%#v context=%v", result, fake.confirmContextErr)
	}
}

func TestExecutorRejectsFractionalAndOutOfRangeDiscoveryArguments(t *testing.T) {
	executor, err := NewExecutor(&fakeGateway{}, "call-arguments-0001", context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, arguments := range []map[string]any{
		{"category_id": 1.5},
		{"cursor": -1},
		{"limit": 21},
	} {
		result := executor.Execute(context.Background(), "browse_catalog", arguments)
		if result["error"].(map[string]any)["code"] != "ORDER_GATEWAY_TOOL_ARGUMENT_INVALID" {
			t.Fatalf("invalid arguments were accepted: %#v", result)
		}
	}
}

func TestExecutorRequiresANewCustomerTurnAfterRequote(t *testing.T) {
	fake := &requoteGateway{}
	executor, err := NewExecutor(fake, "call-requote-tools", context.Background())
	if err != nil {
		t.Fatal(err)
	}
	executor.Execute(context.Background(), "quote_order", map[string]any{})
	executor.NoteCustomerTurn()
	requoted := executor.Execute(context.Background(), "confirm_order", map[string]any{"customer_confirmed": true})
	if requoted["state"] != "requote_required" {
		t.Fatalf("expected replacement quote: %#v", requoted)
	}
	premature := executor.Execute(context.Background(), "confirm_order", map[string]any{"customer_confirmed": true})
	if premature["error"].(map[string]any)["code"] != "ORDER_GATEWAY_CONFIRMATION_TURN_REQUIRED" || fake.confirmations != 1 {
		t.Fatalf("replacement quote reused old confirmation: %#v", premature)
	}
	executor.NoteCustomerTurn()
	completed := executor.Execute(context.Background(), "confirm_order", map[string]any{"customer_confirmed": true})
	if completed["state"] != "completed" || fake.confirmations != 2 {
		t.Fatalf("fresh replacement confirmation failed: %#v", completed)
	}
}

func TestDeclarationsAreBlockingAndComplete(t *testing.T) {
	declarations := Declarations()
	if len(declarations) != 7 {
		t.Fatalf("got %d declarations", len(declarations))
	}
	for _, declaration := range declarations {
		if string(declaration.Behavior) != "BLOCKING" {
			t.Fatalf("%s is not blocking", declaration.Name)
		}
	}
}

func TestStaffRequestStopsAutomatedConfirmationWithoutPretendingToTransfer(t *testing.T) {
	fake := &fakeGateway{}
	executor, err := NewExecutor(fake, "call-human-0001", context.Background())
	if err != nil {
		t.Fatal(err)
	}
	executor.Execute(context.Background(), "quote_order", map[string]any{})
	executor.NoteCustomerTurn()
	result := executor.Execute(context.Background(), "request_staff", nil)
	if result["state"] != "staff_required" || result["transfer_connected"] != false {
		t.Fatalf("invalid handoff: %#v", result)
	}
	blocked := executor.Execute(context.Background(), "confirm_order", map[string]any{"customer_confirmed": true})
	if blocked["ok"] != false || fake.confirmed != 0 {
		t.Fatalf("handoff submitted an order: %#v", blocked)
	}
}
