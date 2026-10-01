const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
for (const TZ of ['UTC', 'Asia/Amman', 'America/New_York']) {
    const script = `const {formatBusinessTime:f}=require(${JSON.stringify(require.resolve('../businessTime'))});
        console.log(JSON.stringify([
            f('2026-09-09T18:30','+03:00',true),
            f('2026-09-09 23:30:00','+03:00'),
            f('2026-09-09T23:30:00Z','+04:30'),
            f('2026-09-09'),f('2026-09-09 06:30:00 PM')
        ]));`;
    const result = JSON.parse(execFileSync(process.execPath,['-e',script],{env:{...process.env,TZ},encoding:'utf8'}));
    assert.deepEqual(result,['2026-09-09 06:30:00 PM','2026-09-10 02:30:00 AM','2026-09-10 04:00:00 AM','2026-09-09','2026-09-09 06:30:00 PM']);
}
console.log('Business time: all three host timezones passed.');
