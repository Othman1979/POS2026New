// Spoolers can run in a different timezone from the venue. Use the clock
// configuration frozen into the job, including for legacy HTML fallbacks.
function formatBusinessTime(value, offset = '+03:00', scheduled = false) {
    if (value == null || value === '') return '';
    const raw = value instanceof Date ? value.toISOString() : String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw) || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? [AP]M$/i.test(raw)) return raw;
    const zone = /^[+-](0\d|1[0-4]):[0-5]\d$/.test(offset) ? offset : '+03:00';
    const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw);
    const date = new Date(hasZone ? raw : `${raw.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return raw;
    const [h,m] = zone.slice(1).split(':').map(Number);
    const shift = scheduled && !hasZone ? 0 : (zone[0] === '-' ? -1 : 1) * (h * 60 + m) * 60000;
    const wall = new Date(date.getTime() + shift);
    const pad = n => String(n).padStart(2,'0');
    const hour = wall.getUTCHours();
    return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth()+1)}-${pad(wall.getUTCDate())} ${pad(hour%12||12)}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())} ${hour>=12?'PM':'AM'}`;
}
module.exports = { formatBusinessTime };
