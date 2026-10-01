# Direct Print Template Publishing Design

## Decision

Publishing a saved receipt or kitchen template is a single explicit `Accept & Publish` action. The admin will validate the result with a normal test order after publishing; printer-specific test jobs, paper confirmations, and coverage checks must not gate publishing or runtime use.

## User flow

1. The admin edits the template and uses the existing `Save Revision` action.
2. The Publish pane shows the active template, the selected saved revision, and one `Accept & Publish` button.
3. The button is disabled while edits are unsaved or when the selected revision is already active.
4. One click activates the selected revision without a printer selector, test-print polling, paper confirmation, reason prompt, or confirmation modal.
5. Every active printer of the matching document type uses that active revision. A newly added or reconfigured matching printer also uses it without separate approval.

## Preserved safeguards

- The server still validates document type, revision ownership, and optimistic lock version.
- Invalid, inactive, or wrong-role printer targets still fail before queue insertion.
- Template schema validation, compilation limits, diagnostic recording, and safe built-in fallback remain unchanged.
- Activation remains transactional and audited. The browser sends the fixed audit reason `Accepted and published from template editor.` for custom activation.
- Revision history and built-in rollback remain available. Restoring the built-in keeps its existing explicit reason and confirmation flow.

## Removed workflow

- The Publish pane no longer exposes printer selection, Test Print, queue polling, Confirm Paper, or required printer coverage.
- Custom activation no longer requires any active printer to exist and no longer queries `print_template_revision_tests`.
- Runtime template resolution no longer checks per-printer confirmation before using the globally active revision.
- Saved custom revisions remain valid rollback targets without test coverage.

## Compatibility and scope

The existing test-print and confirmation endpoints, database table, and historical rows remain in place but are not used by the admin page or activation/runtime decisions. Removing that dormant compatibility surface would require an unrelated API and schema migration and is outside this change.

No spooler, print queue delivery, renderer, template schema, installer, deployment, or database migration changes are included.

## Acceptance cases

- A saved custom revision publishes when there are zero matching printers.
- The active revision compiles for an existing, newly added, or reconfigured matching printer without a confirmation row.
- A wrong-role, inactive, missing, or unroutable printer is still rejected.
- A stale lock version or revision belonging to another document type is rejected.
- The Publish pane contains no test-print ceremony and one custom publish action.
- Unsaved edits cannot be accidentally published; the admin must save first.
- Publishing triggers one activation request and no prompt or confirmation dialog.
- Built-in rollback still works and remains audited.
