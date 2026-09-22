/**
 * Display formatting only. Nothing here computes a value the program would; it renders
 * values the SDK already produced. Times are formatted against explicit zones so the
 * server and the browser print the same string.
 */

const utcFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const etFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York',
  weekday: 'short',
  day: 'numeric',
  month: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const etClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function parts(format: Intl.DateTimeFormat, unix: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of format.formatToParts(new Date(unix * 1000))) out[p.type] = p.value;
  return out;
}

/** `2026-09-20 10:14:54 UTC` */
export function utc(unix: number): string {
  const p = parts(utcFormat, unix);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} UTC`;
}

/** `2026-09-20 10:14 UTC` */
export function utcMinute(unix: number): string {
  const p = parts(utcFormat, unix);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} UTC`;
}

// ICU has started printing "Sept"; the month is spelled here so it cannot drift.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** `Mon 21 Sep 09:30 ET` */
export function et(unix: number): string {
  const p = parts(etFormat, unix);
  return `${p.weekday} ${p.day} ${MONTHS[Number(p.month) - 1] ?? p.month} ${p.hour}:${p.minute} ET`;
}

/** `Sun 06:14:54 ET` */
export function etTime(unix: number): string {
  const p = parts(etClock, unix);
  return `${p.weekday} ${p.hour}:${p.minute}:${p.second} ET`;
}

/** A span of seconds, in the two largest units: `61 h 25 m`, `3 m 12 s`, `45 s`. */
export function span(seconds: number): string {
  const s = Math.max(0, Math.floor(Math.abs(seconds)));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d >= 3) return `${d} d ${h} h`;
  if (d > 0 || h > 0) return `${d * 24 + h} h ${m} m`;
  if (m > 0) return `${m} m ${r} s`;
  return `${r} s`;
}

/** A price as read, to four places, with a true minus sign. */
export function price(value: number, places = 4): string {
  return minus(value.toFixed(places));
}

export function bps(value: number, places = 1): string {
  const text = value.toFixed(places);
  return `${Number(text) > 0 ? '+' : ''}${minus(text)} bps`;
}

export function signed(value: number, places = 4): string {
  const text = value.toFixed(places);
  return value > 0 ? `+${text}` : minus(text);
}

export function minus(text: string): string {
  return text.replace(/^-/, '−');
}

/** An on-chain f64 multiplier, as the keeper recorded it: `1.0` for whole values. */
export function multiplier(value: number): string {
  if (Number.isInteger(value)) return value.toFixed(1);
  return value.toFixed(10).replace(/0+$/, '');
}

/** `XsbE…JzJp`: enough of an address to recognise it; the link carries the rest. */
export function short(address: string, head = 4, tail = 4): string {
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'] as const;
export function roman(n: number): string {
  return ROMAN[n] ?? String(n);
}

/** `MarketClosed` → `MARKET CLOSED` */
export function refusalTitle(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
}

/** An integer amount with `decimals` places, from its decimal string, without floating point. */
export function units(raw: string, decimals: number): string {
  const negative = raw.startsWith('-');
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = decimals > 0 ? `.${digits.slice(digits.length - decimals)}` : '';
  return `${negative ? '−' : ''}${whole}${frac}`;
}
