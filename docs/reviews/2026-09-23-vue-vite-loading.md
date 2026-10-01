# Vue/Vite POS loading review — 2026-09-23

The current Vite 6 build already lazy-loads the register and floor-plan routes,
the Arabic dictionary, and infrequent POS dialogs. A temporary build that
removed the dedicated Socket.IO chunk saved 15.4 KB gzip on login but did not
reduce total register bytes or show a reliable cold-register latency win; that
chunk experiment was not shipped. The online [Vite agent skill](https://github.com/antfu/skills/blob/main/skills/vite/SKILL.md)
targets Vite 8 beta, so version-specific decisions used the installed Vite 6
behavior and [Vite 6 documentation](https://v6.vite.dev/guide/features). The
[Vue best-practices skill](https://github.com/vuejs-ai/skills/blob/main/skills/vue-best-practices/SKILL.md)
was also reviewed; its broad TypeScript and component-splitting advice was not
applied to this measured JavaScript hot path.

The measured runtime work was the shared DOM translation pass. Before this
change, an English-only session installed the translation observer and walked
new category DOM even though English translation returns the original text.
The scheduler also canceled and replaced a pending whole-root translation with
later mutation targets. A browser reproduction showed a newly inserted
"Orders" label staying English after switching to Arabic. Both the unchanged
build and the isolated English-only fast-path prototype reproduced that failure.

The runtime now omits translation walks until Arabic has been selected in the
page session. After Arabic is used, the observer remains active even when the
user returns to English, so detached translated nodes can be restored when
reinserted. Pending translation targets accumulate for one animation frame;
an ancestor pass covers its descendants without discarding a language switch.
If a background tab delays the frame, more than 256 queued nodes collapse to
their connected top-level subtrees to bound retained references.

| Fourfold CPU browser fixture | Viewport | Before | After |
| --- | --- | ---: | ---: |
| English `SHOW_TEXT` walker creations, six category changes | 1440px desktop | 726 | 0 |
| Arabic `SHOW_TEXT` walker creations, six category changes | 390px mobile | 726 | 12 |
| English scripting time, six changes, median of 3 rounds | 1440px desktop | 589 ms | 527 ms |
| Arabic scripting time, six changes, median of 3 rounds | 390px mobile | 611 ms | 586 ms |
| English cold-register scripting time, median of 3 rounds | 1440px desktop | 500 ms | 467 ms |
| Arabic cold-register scripting time, median of 3 rounds | 390px mobile | 521 ms | 550 ms |

The English category scripting reduction was 62 ms across six changes in this
fixture; Arabic improved 25 ms (611 → 586 ms). Cold-register timing does not establish a
reliable win, and the three-round Arabic sample was 29 ms higher. A focused
eight-run repeat of Arabic mobile cold startup measured 529 ms baseline versus
522 ms changed (medians), so that increase was not consistent. The i18n chunk increased by
145 bytes gzip in these builds. These are local synthetic
read-only fixtures with Chromium CPU throttling, not customer-machine or
Hostinger measurements. The before/after runs were sequential, so timing noise
remains; the eliminated walker work is directly observed. The raw runs are in
ignored `scratch/pos-frontend-i18n-base-final/` and
`scratch/pos-frontend-i18n-capped-perf/`.
The cold-start repeat is in `scratch/pos-frontend-i18n-baseline-ar-cold-repeat/`
and `scratch/pos-frontend-i18n-current-ar-cold-repeat/`.

Validation: `npm run build`, all 907 frontend tests, and the four-case
English/Arabic desktop/mobile production-build browser matrix passed. The
browser matrix exercised POS and admin language changes, dynamic text,
title/aria/placeholder attributes, `data-no-i18n`, detached-node restoration,
rapid switches, category navigation, register/cart/notes, table floor plan,
and admin order views. A focused paused-frame burst verified translation of 300
queued labels; it did not measure retained heap or directly assert the queue
limit. Menu and receipt entry-point language switching was smoke-tested with
synthetic labels, without rendering a receipt payload. The checks reported no
page errors, unknown endpoints, or
business writes. One expected controlled HTTP 500 console entry came from
the fixture's failure/retry scenario. The test did not contact a database,
payment service, or physical printer.
