package outbox

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const SchemaVersion = 1

var externalIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{8,128}$`)

type Row struct {
	ExternalRequestID string
	State             string
	Draft             map[string]any
	QuoteToken        string
	Quote             map[string]any
	Submission        map[string]any
	ConfirmedAt       string
	Result            map[string]any
	AttemptCount      int
	LastErrorCode     string
	LastErrorMessage  string
	CreatedAt         string
	UpdatedAt         string
}

type Store struct {
	db  *sql.DB
	mu  sync.Mutex
	now func() time.Time
}

type CodedError interface {
	error
	ErrorCode() string
}

func Open(filename string) (*Store, error) {
	return open(filename, time.Now)
}

func open(filename string, now func() time.Time) (*Store, error) {
	if filename == "" {
		return nil, errors.New("an outbox database path is required")
	}
	if filename != ":memory:" {
		absolute, err := filepath.Abs(filename)
		if err != nil {
			return nil, fmt.Errorf("resolve outbox path: %w", err)
		}
		filename = absolute
		if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
			return nil, fmt.Errorf("create outbox directory: %w", err)
		}
	}
	database, err := sql.Open("sqlite", filename)
	if err != nil {
		return nil, fmt.Errorf("open outbox: %w", err)
	}
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	store := &Store{db: database, now: now}
	if err := store.initialize(filename != ":memory:"); err != nil {
		database.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) initialize(persisted bool) error {
	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("read outbox schema version: %w", err)
	}
	if version > SchemaVersion {
		return fmt.Errorf("outbox schema version %d is newer than this gateway supports", version)
	}
	statements := []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=FULL",
		"PRAGMA busy_timeout=5000",
		`CREATE TABLE IF NOT EXISTS order_outbox (
            external_request_id TEXT PRIMARY KEY,
            state TEXT NOT NULL CHECK (state IN (
                'draft', 'quoted', 'pending', 'completed',
                'requote_required', 'blocked', 'handoff_locked'
            )),
            draft_json TEXT NOT NULL,
            quote_token TEXT,
            quote_json TEXT,
            submission_json TEXT,
            confirmed_at TEXT,
            result_json TEXT,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_error_code TEXT,
            last_error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )`,
		`CREATE INDEX IF NOT EXISTS idx_order_outbox_state_updated
            ON order_outbox (state, updated_at)`,
		fmt.Sprintf("PRAGMA user_version=%d", SchemaVersion),
	}
	for _, statement := range statements {
		if _, err := s.db.Exec(statement); err != nil {
			return fmt.Errorf("initialize outbox: %w", err)
		}
	}
	if persisted {
		// Windows retains the current user's inherited ACL; Unix honors this mode.
		_ = os.Chmod(s.databaseFilename(), 0o600)
	}
	return nil
}

func (s *Store) databaseFilename() string {
	var filename string
	_ = s.db.QueryRow("PRAGMA database_list").Scan(new(int), new(string), &filename)
	return filename
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Get(externalRequestID string) (*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getLocked(externalRequestID)
}

func (s *Store) Require(externalRequestID string) (*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requireLocked(externalRequestID)
}

func (s *Store) SaveDraft(draft map[string]any) (*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	externalRequestID, _ := draft["external_request_id"].(string)
	if !externalIDPattern.MatchString(externalRequestID) {
		return nil, errors.New("the draft needs an 8-128 character safe external_request_id")
	}
	existing, err := s.getLocked(externalRequestID)
	if err != nil {
		return nil, err
	}
	if existing != nil && !mutableState(existing.State) {
		return nil, fmt.Errorf("the %s order draft is immutable", existing.State)
	}
	encoded, err := encode(draft)
	if err != nil {
		return nil, err
	}
	timestamp := s.timestamp()
	if existing == nil {
		_, err = s.db.Exec(`INSERT INTO order_outbox
            (external_request_id, state, draft_json, created_at, updated_at)
            VALUES (?, 'draft', ?, ?, ?)`, externalRequestID, encoded, timestamp, timestamp)
	} else {
		_, err = s.db.Exec(`UPDATE order_outbox
            SET state='draft', draft_json=?, quote_token=NULL, quote_json=NULL,
                submission_json=NULL, confirmed_at=NULL, result_json=NULL,
                last_error_code=NULL, last_error_message=NULL, updated_at=?
            WHERE external_request_id=?`, encoded, timestamp, externalRequestID)
	}
	if err != nil {
		return nil, fmt.Errorf("save outbox draft: %w", err)
	}
	return s.requireLocked(externalRequestID)
}

func (s *Store) SaveQuote(externalRequestID string, quote map[string]any) (*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, err := s.requireLocked(externalRequestID)
	if err != nil {
		return nil, err
	}
	if !mutableState(existing.State) {
		return nil, fmt.Errorf("the %s order cannot accept a new quote", existing.State)
	}
	quoteToken, _ := quote["quote_token"].(string)
	if quoteToken == "" {
		return nil, errors.New("the quote does not contain a quote_token")
	}
	encoded, err := encode(quote)
	if err != nil {
		return nil, err
	}
	_, err = s.db.Exec(`UPDATE order_outbox
        SET state='quoted', quote_token=?, quote_json=?, submission_json=NULL,
            confirmed_at=NULL, last_error_code=NULL, last_error_message=NULL, updated_at=?
        WHERE external_request_id=?`, quoteToken, encoded, s.timestamp(), externalRequestID)
	if err != nil {
		return nil, fmt.Errorf("save outbox quote: %w", err)
	}
	return s.requireLocked(externalRequestID)
}

func (s *Store) MarkPending(externalRequestID string) (*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, err := s.requireLocked(externalRequestID)
	if err != nil {
		return nil, err
	}
	if existing.State == "pending" {
		return existing, nil
	}
	if (existing.State != "quoted" && existing.State != "requote_required") || existing.QuoteToken == "" {
		return nil, fmt.Errorf("the %s order does not have a confirmable quote", existing.State)
	}
	submission := map[string]any{
		"draft": existing.Draft, "quote_token": existing.QuoteToken, "confirmed": true,
	}
	encoded, err := encode(submission)
	if err != nil {
		return nil, err
	}
	timestamp := s.timestamp()
	_, err = s.db.Exec(`UPDATE order_outbox
        SET state='pending', submission_json=?, confirmed_at=?,
            last_error_code=NULL, last_error_message=NULL, updated_at=?
        WHERE external_request_id=?`, encoded, timestamp, timestamp, externalRequestID)
	if err != nil {
		return nil, fmt.Errorf("mark outbox pending: %w", err)
	}
	return s.requireLocked(externalRequestID)
}

func (s *Store) RecordAttempt(externalRequestID string, operationError error) (*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, err := s.requireLocked(externalRequestID)
	if err != nil {
		return nil, err
	}
	if existing.State != "pending" {
		return nil, errors.New("only a pending order can record a create attempt")
	}
	code, message := errorFields(operationError)
	_, err = s.db.Exec(`UPDATE order_outbox
        SET attempt_count=attempt_count+1, last_error_code=?, last_error_message=?, updated_at=?
        WHERE external_request_id=?`, nullable(code), nullable(message), s.timestamp(), externalRequestID)
	if err != nil {
		return nil, fmt.Errorf("record outbox attempt: %w", err)
	}
	return s.requireLocked(externalRequestID)
}

func (s *Store) RecordError(externalRequestID string, operationError error) (*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, err := s.requireLocked(externalRequestID)
	if err != nil {
		return nil, err
	}
	if existing.State != "pending" && existing.State != "handoff_locked" {
		return nil, errors.New("only a pending or handoff-locked order can record a create error")
	}
	code, message := errorFields(operationError)
	_, err = s.db.Exec(`UPDATE order_outbox
        SET last_error_code=?, last_error_message=?, updated_at=?
        WHERE external_request_id=?`, nullable(code), nullable(message), s.timestamp(), externalRequestID)
	if err != nil {
		return nil, fmt.Errorf("record outbox error: %w", err)
	}
	return s.requireLocked(externalRequestID)
}

func (s *Store) MarkCompleted(externalRequestID string, result map[string]any) (*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, err := s.requireLocked(externalRequestID)
	if err != nil {
		return nil, err
	}
	if existing.State != "pending" && existing.State != "handoff_locked" && existing.State != "completed" {
		return nil, fmt.Errorf("the %s order cannot be completed", existing.State)
	}
	if !validPositiveID(result["id"]) {
		return nil, errors.New("a completed order requires a valid held-order result")
	}
	encoded, err := encode(result)
	if err != nil {
		return nil, err
	}
	_, err = s.db.Exec(`UPDATE order_outbox
        SET state='completed', result_json=?, last_error_code=NULL,
            last_error_message=NULL, updated_at=? WHERE external_request_id=?`, encoded, s.timestamp(), externalRequestID)
	if err != nil {
		return nil, fmt.Errorf("complete outbox order: %w", err)
	}
	return s.requireLocked(externalRequestID)
}

func (s *Store) MarkRequoteRequired(externalRequestID string, quote map[string]any, operationError error) (*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, err := s.requireLocked(externalRequestID)
	if err != nil {
		return nil, err
	}
	if existing.State != "pending" {
		return nil, errors.New("only a pending order can require a new quote")
	}
	quoteToken, _ := quote["quote_token"].(string)
	encoded, err := encodeNullable(quote)
	if err != nil {
		return nil, err
	}
	code, message := errorFields(operationError)
	_, err = s.db.Exec(`UPDATE order_outbox
        SET state='requote_required', quote_token=?, quote_json=?, submission_json=NULL,
            confirmed_at=NULL, last_error_code=?, last_error_message=?, updated_at=?
        WHERE external_request_id=?`, nullable(quoteToken), encoded, nullable(code), nullable(message), s.timestamp(), externalRequestID)
	if err != nil {
		return nil, fmt.Errorf("mark outbox requote: %w", err)
	}
	return s.requireLocked(externalRequestID)
}

func (s *Store) MarkBlocked(externalRequestID string, operationError error) (*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, err := s.requireLocked(externalRequestID)
	if err != nil {
		return nil, err
	}
	if (existing.State == "completed" || existing.State == "handoff_locked") && existing.State != "blocked" {
		return nil, fmt.Errorf("the %s order cannot be blocked", existing.State)
	}
	code, message := errorFields(operationError)
	if code == "" {
		code = "ORDER_GATEWAY_BLOCKED"
	}
	if message == "" {
		message = "Order needs manual review."
	}
	_, err = s.db.Exec(`UPDATE order_outbox
        SET state='blocked', last_error_code=?, last_error_message=?, updated_at=?
        WHERE external_request_id=?`, code, message, s.timestamp(), externalRequestID)
	if err != nil {
		return nil, fmt.Errorf("block outbox order: %w", err)
	}
	return s.requireLocked(externalRequestID)
}

func (s *Store) MarkHandoffLocked(externalRequestID string) (*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, err := s.requireLocked(externalRequestID)
	if err != nil {
		return nil, err
	}
	if existing.State != "pending" {
		return nil, errors.New("only a pending order can be handed off")
	}
	_, err = s.db.Exec(`UPDATE order_outbox SET state='handoff_locked', updated_at=?
        WHERE external_request_id=?`, s.timestamp(), externalRequestID)
	if err != nil {
		return nil, fmt.Errorf("lock outbox handoff: %w", err)
	}
	return s.requireLocked(externalRequestID)
}

func (s *Store) ListPending() ([]*Row, error)       { return s.listStates("pending") }
func (s *Store) ListHandoffLocked() ([]*Row, error) { return s.listStates("handoff_locked") }
func (s *Store) ListPendingLimit(limit int) ([]*Row, error) {
	return s.listStatesLimit(limit, "pending")
}
func (s *Store) ListHandoffLockedLimit(limit int) ([]*Row, error) {
	return s.listStatesLimit(limit, "handoff_locked")
}
func (s *Store) ListUnresolved() ([]*Row, error) {
	return s.listStates("pending", "handoff_locked", "requote_required", "blocked")
}

func (s *Store) listStates(states ...string) ([]*Row, error) {
	return s.listStatesLimit(0, states...)
}

func (s *Store) listStatesLimit(limit int, states ...string) ([]*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(states) == 0 {
		return nil, nil
	}
	placeholders := "?"
	arguments := make([]any, len(states))
	for index, state := range states {
		arguments[index] = state
		if index > 0 {
			placeholders += ",?"
		}
	}
	query := `SELECT * FROM order_outbox WHERE state IN (` + placeholders + `)
        ORDER BY updated_at, external_request_id`
	if limit > 0 {
		query += " LIMIT ?"
		arguments = append(arguments, limit)
	}
	rows, err := s.db.Query(query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("list outbox orders: %w", err)
	}
	defer rows.Close()
	result := []*Row{}
	for rows.Next() {
		row, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func (s *Store) getLocked(externalRequestID string) (*Row, error) {
	row, err := scanRow(s.db.QueryRow("SELECT * FROM order_outbox WHERE external_request_id=?", externalRequestID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

func (s *Store) requireLocked(externalRequestID string) (*Row, error) {
	row, err := s.getLocked(externalRequestID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, fmt.Errorf("no outbox order exists for %s", externalRequestID)
	}
	return row, nil
}

type scanner interface{ Scan(dest ...any) error }

func scanRow(source scanner) (*Row, error) {
	var row Row
	var draft string
	var quote, submission, result, quoteToken, confirmedAt, errorCode, errorMessage sql.NullString
	err := source.Scan(
		&row.ExternalRequestID, &row.State, &draft, &quoteToken, &quote, &submission,
		&confirmedAt, &result, &row.AttemptCount, &errorCode, &errorMessage, &row.CreatedAt, &row.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	row.QuoteToken = quoteToken.String
	row.ConfirmedAt = confirmedAt.String
	row.LastErrorCode = errorCode.String
	row.LastErrorMessage = errorMessage.String
	if row.Draft, err = decodeRequired(draft, "draft JSON"); err != nil {
		return nil, err
	}
	if row.Quote, err = decodeNullable(quote.String, "quote JSON"); err != nil {
		return nil, err
	}
	if row.Submission, err = decodeNullable(submission.String, "submission JSON"); err != nil {
		return nil, err
	}
	if row.Result, err = decodeNullable(result.String, "result JSON"); err != nil {
		return nil, err
	}
	return &row, nil
}

func encode(value map[string]any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("encode outbox JSON: %w", err)
	}
	return string(encoded), nil
}

func encodeNullable(value map[string]any) (any, error) {
	if value == nil {
		return nil, nil
	}
	return encode(value)
}

func decodeRequired(raw, label string) (map[string]any, error) {
	if raw == "" {
		return nil, fmt.Errorf("the outbox contains invalid %s", label)
	}
	return decode(raw, label)
}

func decodeNullable(raw, label string) (map[string]any, error) {
	if raw == "" {
		return nil, nil
	}
	return decode(raw, label)
}

func decode(raw, label string) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	decoder.UseNumber()
	result := map[string]any{}
	if err := decoder.Decode(&result); err != nil {
		return nil, fmt.Errorf("the outbox contains invalid %s", label)
	}
	return result, nil
}

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

func mutableState(state string) bool {
	return state == "draft" || state == "quoted" || state == "requote_required"
}

func errorFields(err error) (string, string) {
	if err == nil {
		return "", ""
	}
	code := ""
	var coded CodedError
	if errors.As(err, &coded) {
		code = coded.ErrorCode()
	}
	return code, err.Error()
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (s *Store) timestamp() string { return s.now().UTC().Format(time.RFC3339Nano) }
