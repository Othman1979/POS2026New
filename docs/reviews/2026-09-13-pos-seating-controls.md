# POS seating controls follow-up

The floor plan used the new independent seating relation, but the POS cart still decided Join/Disjoin availability and selected disjoin children using `parent_table_id`. A real built-browser baseline reproduced a missing Disjoin button on an occupied seating child.

The POS controls now use `seating_parent_id`. A child can leave its seating group; a parent can dissolve its group's seating. Join is hidden for a child, a printed source or a group containing a printed bill. Virtual split sessions do not expose seating controls. The existing disjoin manager-PIN path remains available. Arabic Join now reads **ضم**, consistently describing seating rather than bill combination.

After disjoining, the workflow already refreshes table metadata. The POS no longer reopens the bill afterward: that extra QR/order read was unnecessary and would discard an unsaved cart. Financial alias resolution, whole-order transfer and bill ownership continue to use their existing financial fields.

Verification: 28 existing focused floor/read-ownership frontend cases passed; production build passed. The same guarded browser test that failed before the fix passed in English desktop and Arabic mobile, exercising child disjoin with a 4 JD saved bill plus 2 JD unsaved draft retained, root dissolution, unchanged saved orders/items, and printed-child Join suppression with Disjoin retained. No browser page errors occurred. The initial desktop diagnostic capture caught a transition; the capture was repeated after network idle before visual review. No customer DB or printer was used. Logs, screenshots and generated-fixture cleanup evidence are in `scratch/table-pos-seating-20260913/`.
