# Product context

## Product

This is a bilingual, restaurant-first point-of-sale product. It covers live service, tables, orders, shifts, reporting, administration, and the operational workflows around them. It is a working product interface, not a marketing website.

## Register

product

## Platform

web

## Users

Cashiers, waiters, owners, managers, administrators, and programmers are all primary users. Each role must be able to complete its permitted work without unnecessary friction or ambiguity.

## Purpose and success

The product should keep restaurant operations fast, correct, and easy to learn while reducing cashier mistakes. Shifts must be tightly controlled, and sensitive operational actions must be traceable through audit logs so misuse cannot happen silently.

Success means users can serve customers quickly, managers can trust the operational and financial records, and owners can understand what happened during a shift without reconstructing it manually.

The product must remain a sound foundation for larger operations, including future inventory and accounting integrations, without introducing enterprise complexity before it is needed.

## Positioning

A bilingual, restaurant-first POS that keeps live service fast, shifts controlled, and every important action accountable without enterprise complexity.

## Personality

- Calm
- Practical
- Trustworthy

## Design reference

The current polished POS interface is the primary visual and interaction reference. Future work should refine and extend its established language rather than replace it with an unrelated design.

## Avoid

- Generic AI-style layouts or unnatural interface copy
- Excessive rounding, padding, glare, gradients, decorative icons, or heavy shadows
- Clutter, oversized cards, and decoration that competes with operational information
- Unnecessary motion, flicker, or transitions that slow down live service
- Inconsistent controls or unfamiliar affordances without an operational reason

## Accessibility and interaction

- Meet practical WCAG AA expectations for contrast, focus visibility, keyboard use, and understandable states.
- Keep controls touch-friendly, with a minimum target size of 44px where practical.
- Support Arabic, English, and right-to-left layouts throughout the product.
- Display digits using Latin numerals in both languages while preserving the product's existing currency presentation.
- Respect reduced-motion preferences and use motion only to communicate state.
- Treat responsive behavior as structural: layouts must adapt intentionally to phones, tablets, desktop screens, and dedicated touch POS hardware such as NCR and PAR terminals.
