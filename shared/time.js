// Time helpers shared by the server, the rules engine and the browser.
// All stored timestamps are ISO-8601 UTC strings; availability windows are
// agency-local "HH:MM" strings evaluated in the runtime's local timezone.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const ms = (iso) => (iso instanceof Date ? iso.getTime() : new Date(iso).getTime());
export const iso = (t) => new Date(t).toISOString();
export const addMinutes = (t, m) => iso(ms(t) + m * MINUTE);

export function overlaps(a, b) {
  return ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);
}

export function parseHM(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

export function minutesOfDay(t) {
  const d = new Date(ms(t));
  return d.getHours() * 60 + d.getMinutes();
}

export function startOfDay(t) {
  const d = new Date(ms(t));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function sameLocalDay(a, b) {
  return startOfDay(a) === startOfDay(b);
}

// Monday 00:00 local of the week containing t.
export function startOfWeek(t) {
  const d = new Date(startOfDay(t));
  const offset = (d.getDay() + 6) % 7;
  return d.getTime() - offset * DAY;
}

export function durationHours(v) {
  return (ms(v.end) - ms(v.start)) / HOUR;
}

export function fmtTime(t) {
  return new Date(ms(t)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtDay(t) {
  return new Date(ms(t)).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function fmtDateTime(t) {
  return `${fmtDay(t)} ${fmtTime(t)}`;
}

export function relative(t, now = Date.now()) {
  const diff = ms(t) - ms(now);
  const abs = Math.abs(diff);
  const unit = abs < HOUR ? [Math.round(abs / MINUTE), 'min'] : abs < DAY ? [Math.round(abs / HOUR), 'h'] : [Math.round(abs / DAY), 'd'];
  return diff >= 0 ? `in ${unit[0]} ${unit[1]}` : `${unit[0]} ${unit[1]} ago`;
}
