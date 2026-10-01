# Arabic busy-table join warning — F10

The Arabic floor displayed `Occupied tables cannot be joined.` in English because
the runtime catalog lacked that key. It now displays `لا يمكن ضم الطاولات المشغولة.`
No join eligibility, request, bill or navigation behavior changed.

- The runtime language regression failed before the catalog edit (four existing
  catalog cases passed), and a fresh built Arabic mobile run reproduced the English
  message with both saved bills unchanged.
- After the edit, 22 catalog/localization/lifecycle tests and the production build
  passed.
- Real server/generated loopback database and built English/Arabic desktop/mobile
  UI: busy selection shows the correct language and is not selected; an available
  table can be selected; Cancel exits join mode; reopening the other bill shows its
  original 4 JD total. All four cases pass with no join POST, split-detail request,
  bill/table mutation or page error. No physical printing is involved.

Raw scripts, screenshots and before/after evidence are in ignored
`scratch/tables-f10-20260913/`. This catalog-only change needs no query/performance
benchmark. No environment, schema, deployment, GitHub or protection change occurred.
