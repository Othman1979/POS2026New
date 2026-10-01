# Recipe ledger correction evidence — 5 September 2026

Historical planning evidence. Implementation and all four review phases were subsequently completed; see the [Phase 4 review](reviews/2026-09-06-recipe-ledger-phase-4.md) for current behavior and verification.

Scope: corrections to research and plan only. Application source was inspected at 1c84ce17; the defective plan is preserved in Git at 177ea113. No application code, migration, database, or deployment is changed here.

## Corrections, one by one

| # | Defect and evidence | Corrected contract / required implementation proof |
| --- | --- | --- |
| 1 | Old plan Task 3 planSyncRows iterates CURRENT ingredients on additions and interprets absent demand as removal. Task 4 loadRecorded overwrites productQty with each ingredient's independently summed product_qty. Adding Pepsi after two meals makes counts 3/3/1; a repeated unchanged save then consumes again. Clearing the recipe reverses existing meals. | Freeze complete line composition, including empty; compare saved allocations by usage_key. Execute probes below; future DB test must reload real rows then repeat sync. |
| 2 | Old resolveDemand pools by product_id. Two bundles, one with Pepsi removed, produce an average 0.5 can per refund. Two merged recipes 200/250 g average to 225 g. A line contributing nothing is omitted altogether. | Distinct saved-line tokens and exact allocated components; refund the chosen order_item_id. Existing saveTableOrder savedRowsById and splitChecks saved id validation provide the identity seam; snapshot fields must be added explicitly. |
| 3 | executeCheckout distinguishes isProgressiveSplit and skips deduction only for that branch (around 563, 1678). parent_invoice_id can exist on both split types. Old Task 6 routes every child refund to parent. | Progressive children inherit allocations; legacy children own settlement usage. Use stored usage origin. Test both actual refund paths; parent id alone is insufficient. |
| 4 | Old manual API and recipe API accept qty without a unit; recordManualMovement converts using the ingredient's current display_unit. A 2 kg form submitted after preference changes to g becomes 2 g. | Send qty + explicit unit; validate dimension, convert that unit, retain it in UI state. Future API test changes display preference between load and submit. |
| 5 | Old route contract and Task 8 require qty > 0 for every kind. | Count allows 0; receipt/waste and recipe quantities must remain positive. Behavioral API/UI test. |
| 6 | Old correction unconditionally negates a receipt/waste, and summary sums every row after Count. Receipt +10, Count 100, correction -10 incorrectly yields 90. | A correction affects a counted balance only if its target follows the applicable Count. Unique correction target plus transaction locks; test before/after Count and concurrent duplicate correction. |
| 7 | categoryPriceLists.js:168 sets productIdMap.set(oldId, insertedId); old Task 7 destructures [newId, oldId]. | Iterate [oldId,newId], insert new SELECT old. Test different ids and unchanged original recipe. |
| 8 | Old history starts from a Count without including hidden intervening movements. Count 100, hidden usage -10, displayed usage -5 yields 95 instead of 85. | Count + full prefix + displayed fold; filters never remove accounting inputs. Test pages, date boundaries, multiple Counts and corrections. |
| 9 | Old summary joins/groups complete ingredient_movements history on each refresh. | Separate indexed today, latest Count, and bounded tail reads. This is a query-shape correction, not a measured speed claim: EXPLAIN/load evidence remains required during implementation. |
| 10 | Old plan explicitly publishes ingredients_changed in admin writes but omits it in sale/refund/subscription hooks. | Changed ingredient result reaches transaction caller; emit once after commit for every writer. Test rollback/replay emits nothing and a second admin view refreshes after a sale. |
| 11 | Old Task 2 seeds CREATE TABLE statements then checks information_schema; it never executes migration SQL. Repository migration workflow requires actual predecessor upgrade/no-op and manifest/fallback verification. | Run actual migration on isolated predecessor scratch DB and again; test failed predecessor/checksum. Fixture inspection is separate evidence. Not run in this documentation-only correction. |

Additional consistency corrections: no historical source UPDATE on merge; preserve reset history without FKs to disposable sales/actor rows; explicit cutover for old NULL snapshots; immutable ingredient measure; exact decimal allocation; infrastructure failure distinguished from shortage; remove the incorrect const-hoisting explanation and wording-only frontend tests.

## Executable design probes

Run from repository root with Node. This code reads only the old plan from Git and checks arithmetic; it never loads the application or connects to a database. It deliberately confirms OLD failures as well as corrected reference results. The small reference functions cover these examples, not all production validation, authorization, locking, persistence, or split lifecycle behavior.

~~~js
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }
const original = execFileSync('git', ['show', '177ea113:docs/superpowers/plans/2026-09-05-recipe-ledger.md'], {encoding:'utf8'});
const begin = original.indexOf('const roundSix = (n)');
const end = original.indexOf('module.exports =', begin);
assert(begin >= 0 && end > begin);
const context = {module:{exports:{}}};
vm.runInNewContext(original.slice(begin, original.indexOf(';',end)+1),context);
const { planSyncRows, resolveDemand } = context.module.exports;
const state = (q, entries) => new Map([[1,{productQty:q,byIngredient:new Map(entries)}]]);
const old = state(2,[[10,400],[11,200]]);
check('old clear-recipe defect reproduced', () => {
  assert.equal(planSyncRows(new Map(),old).reduce((s,r)=>s+r.qty,0),600);
});
check('old missing-ingredient addition defect reproduced', () => {
  const rows = planSyncRows(state(3,[[10,600]]),old);
  assert.equal(rows.length,1); assert.equal(rows[0].qty,-200);
});
check('old added-ingredient repeated-save defect reproduced', () => {
  const demand=state(3,[[10,600],[11,300],[12,3]]);
  const added=planSyncRows(demand,old);
  assert.equal(added.find(r=>r.ingredient_id===12).qty,-1);
  // loadRecorded last ingredient overwrites productQty with 1 instead of 3.
  const loaded=state(1,[[10,600],[11,300],[12,1]]);
  const again=planSyncRows(demand,loaded);
  assert.equal(again.find(r=>r.ingredient_id===10).qty,-1200);
  assert.equal(again.find(r=>r.ingredient_id===11).qty,-600);
  assert.equal(again.find(r=>r.ingredient_id===12).qty,-2);
});
check('old bundle average defect reproduced', () => {
  const ctx={recipeLinesByProductId:new Map([
    [2,[{ingredient_id:10,qty_per_unit:200}]],
    [3,[{ingredient_id:12,qty_per_unit:1}]]
  ]),bundleMembersByProductId:new Map([[1,[{product_id:2,qty:1},{product_id:3,qty:1}]]])};
  const d=resolveDemand([{product_id:1,qty:1},{product_id:1,qty:1,bundleItems:[{product_id:3,removed:true}]}],ctx).get(1);
  assert.equal(d.byIngredient.get(12)/d.productQty,0.5);
});
const delta=(components, before, after) => components.map(([id,unit])=>[id,-unit*(after-before)]).filter(([,q])=>q!==0n);
check('frozen line ignores all subsequent recipe edits', () => {
  const frozen=[[10,200n],[11,100n]];
  for(const current of [[],[[10,250n]],[[10,200n],[12,1n]]]) {
    assert.deepEqual(delta(frozen,2n,2n),[]);
    assert.deepEqual(delta(frozen,2n,3n),[[10,-200n],[11,-100n]]);
  }
  assert.deepEqual(delta([],2n,3n),[]);
});
check('line-specific bundle and merged recipe refund', () => {
  assert.deepEqual(delta([[10,200n]],1n,0n),[[10,200n]]);
  assert.deepEqual(delta([[10,200n],[12,1n]],1n,0n),[[10,200n],[12,1n]]);
  assert.equal(delta([[10,250n]],1n,0n)[0][1],250n);
  assert.equal((200+250)/2,225); // pooled result cannot describe either line
});
check('exact split and cumulative refund conserve micro-units', () => {
  const total=1000000n, quantities=[1n,1n,1n], denominator=3n;
  let allocated=0n;
  const shares=quantities.map((q,i)=>{const n=i===2?total-allocated:total*q/denominator; allocated+=n;return n;});
  assert.deepEqual(shares,[333333n,333333n,333334n]);
  assert.equal(shares.reduce((a,b)=>a+b,0n),total);
  let prior=0n;
  const refunds=[1n,2n,3n].map(q=>{const cumulative=total*q/denominator;const d=cumulative-prior;prior=cumulative;return d;});
  assert.equal(refunds.reduce((a,b)=>a+b,0n),total);
});
function balance(rows, horizon=Infinity) {
  const visible=rows.filter(r=>r.id<=horizon);
  const count=visible.filter(r=>r.kind==='count').at(-1);
  if(!count)return null;
  return visible.filter(r=>r.id>count.id).reduce((n,r)=>{
    if(r.kind==='correction' && r.target<=count.id)return n;
    return n+r.qty;
  },count.qty);
}
check('pre-count correction has zero balance effect', () => {
  const rows=[{id:1,kind:'receipt',qty:10},{id:2,kind:'count',qty:100},{id:3,kind:'correction',qty:-10,target:1}];
  assert.equal(100-10,90); // old unconditional formula
  assert.equal(balance(rows),100);
});
check('post-count correction restores balance and later Count supersedes it', () => {
  const rows=[{id:1,kind:'count',qty:100},{id:2,kind:'waste',qty:-10},{id:3,kind:'correction',qty:10,target:2}];
  assert.equal(balance(rows,2),90); assert.equal(balance(rows),100);
  assert.equal(balance([...rows,{id:4,kind:'count',qty:50}]),50);
});
check('hidden history prefix remains in displayed row balance', () => {
  const all=[{id:1,kind:'count',qty:100},{id:2,kind:'usage',qty:-10},{id:3,kind:'usage',qty:-5}];
  assert.equal(balance(all,3),85);
  assert.equal(balance([all[0],all[2]],3),95); // old omitted-prefix result
});
check('zero Count and uncounted balance', () => {
  assert.equal(balance([{id:1,kind:'receipt',qty:10}]),null);
  assert.equal(balance([{id:1,kind:'count',qty:0}]),0);
});
check('explicit unit survives display preference change', () => {
  const form={qty:2,unit:'kg'}, currentDisplay='g';
  const scale={g:1,kg:1000};
  assert.equal(form.qty*scale[currentDisplay],2); // old result
  assert.equal(form.qty*scale[form.unit],2000);
});
check('category copy maps old to new', () => {
  const pairs=[...new Map([[7,81],[9,82]])].map(([oldId,newId])=>({insert:newId,select:oldId}));
  assert.deepEqual(pairs,[{insert:81,select:7},{insert:82,select:9}]);
});
console.log(checks+' design probes passed; no application or database tests run.');
~~~

PowerShell runner (executes the fenced block above):

~~~powershell
$probeDoc = Get-Content -Raw docs/2026-09-05-recipe-ledger-correction-evidence.md
$probeCode = [regex]::Match($probeDoc, '(?s)~~~js\r?\n(.*?)\r?\n~~~').Groups[1].Value
$probeCode | node
~~~

## Verification boundary

Recorded result: **13/13 design probes passed** using the runner above. Source anchors were checked by symbol; line numbers are navigational hints. Migration/DB concurrency, actual sales/refunds/splits/merges, performance, socket delivery, and browser behavior still require implementation and the focused tests listed in the corrected plan. No claim of production readiness follows from these probes.
