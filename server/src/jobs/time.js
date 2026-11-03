// Local days in a store's time zone (stores.timezone, default Asia/Bangkok) without extra libraries.

/** YYYY-MM-DD of `ms` in `tz`. */
export function localDay(ms, tz = 'Asia/Bangkok') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** Offset of `tz` from UTC at instant `ms`, in ms (Bangkok: +7 h). */
function offsetMs(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** [start, end) in epoch ms of local day `day` (YYYY-MM-DD) in `tz`. */
export function dayBounds(day, tz = 'Asia/Bangkok') {
  const [y, m, d] = day.split('-').map(Number);
  const startGuess = Date.UTC(y, m - 1, d);
  const start = startGuess - offsetMs(startGuess, tz);
  const endGuess = Date.UTC(y, m - 1, d + 1);
  const end = endGuess - offsetMs(endGuess, tz);
  return [start, end];
}

/** The local day before `ms` (the day the nightly job summarises). */
export const previousDay = (ms, tz) => localDay(dayBounds(localDay(ms, tz), tz)[0] - 1, tz);
