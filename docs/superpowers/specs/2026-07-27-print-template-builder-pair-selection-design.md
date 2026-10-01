# Print Template Builder Pair Selection and UI Polish

## Goal

Polish the print-template builder's document controls and let an administrator move exactly two positioned elements together without changing the saved print-template schema or spooler contract.

## Scope

This change affects only the admin print-template builder and its server-rendered preview controls.

- Clarify the Receipt/Kitchen document selector and its relationship to fixture selection.
- Improve the command bar at desktop, tablet, and phone widths.
- Show the correct Receipt or Kitchen preview title.
- Support temporary selection and movement of two positioned elements in the same container.
- Preserve existing single selection, single-element resizing, draft saving, presets, revisions, and compiled print output.

It does not add persistent groups, unrestricted multi-selection, marquee selection, alignment guides, or mobile drag positioning.

## Document controls

Receipt and Kitchen form one labelled document-type control with two equal targets. The active document uses the existing teal selected-state vocabulary; the inactive document remains neutral. Fixture selection remains a separate labelled control instead of visually merging with the document selector.

On desktop, document type, fixture, and current-layout status form the context side of the command bar while restore, preview, and save remain actions. On tablet they wrap as coherent groups. On phones the document selector and fixture occupy full rows, while status and actions use the existing two-column layout. Every target remains at least 44px high.

The preview heading is derived from the active compiled artifact's document type: Receipt preview for receipts and Kitchen preview for kitchen tickets.

## Pair selection

The builder retains one primary selected element and may add one companion selection. Pair selection is editor-only state and is never stored in the template definition.

- Plain click selects one element and clears the companion.
- Shift-click, Ctrl-click, or Command-click toggles a companion.
- Shift+Enter is the keyboard equivalent for adding or removing the focused companion.
- Pair selection is allowed only when both elements are positioned children of the same absolute section or absolute row.
- Selecting an incompatible element returns to an ordinary single selection instead of creating a partly valid group.
- The UI shows both selected outlines, distinguishes the primary element, and displays a compact `2 selected` state with a clear-selection action.
- Pair selection clears when switching document type, applying/restoring a preset, choosing a revision, or when either selected node no longer exists.

Flow-layout nodes remain selectable for editing but cannot join a movable pair. Direct positioning and pair movement remain disabled below the existing 1100px interaction breakpoint; phones and tablets continue to use the properties controls and structure ordering.

## Movement rules

Dragging either member of a pair moves both by the same snapped delta, preserving their relative spacing. Arrow keys move both by 4px; Shift+Arrow moves both by 16px.

The permissible delta is the intersection of both elements' available movement ranges. Movement stops as soon as either element reaches a container edge, so neither element can leave or resize the shared container. A pair drag emits one atomic draft update containing both node positions, preventing an intermediate preview refresh or half-moved pair.

The resize handle always resizes only the primary element. Starting a resize never changes the companion's size or position.

## Accessibility and feedback

Overlay controls expose `aria-pressed` for selection state and `aria-keyshortcuts` for pair selection and arrow movement. The compact selection status is announced through a polite live region. Focus remains on the interacted overlay control; selection does not open a modal or move focus unexpectedly.

The existing non-drag alternatives remain available: arrow keys for position and numeric X/Y properties for the primary element. Pair selection never becomes required to complete a layout task.

## State and data flow

`PrintTemplates.vue` owns primary and companion selection because it coordinates document changes, presets, revisions, the editor, and the preview. `PrintTemplatePreview.vue` owns pointer and keyboard interaction and emits either a single-node move or one pair move. The page applies all positions to one cloned definition and sends one draft update.

`PrintTemplateEditor.vue` continues to edit only the primary node's properties. It receives pair-selection state only where needed to show selection status or clear the pair; it does not gain group-editing controls.

No backend, database, template-validator, compiler, or spooler changes are required.

## Verification

Automated browser coverage must prove:

- Document controls remain usable and ordered correctly at desktop, tablet, and phone widths.
- Switching to Kitchen changes the preview heading.
- Modifier selection accepts two positioned siblings and rejects incompatible containers.
- Dragging either selected element moves both by an identical delta without reloading the preview mid-drag.
- Shared clamping prevents either element from crossing any container edge.
- Arrow and Shift+Arrow move the pair by the documented increments.
- Resizing changes only the primary element.
- Plain selection and document/preset/revision changes clear the companion.

Existing print-template unit, integration, browser, and production-build checks must remain green. Physical printer testing is unnecessary because this feature changes only editor state and draft coordinates; compiled output continues through the existing tested path.
