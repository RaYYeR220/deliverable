import { pathToFileURL } from 'node:url';

export function isoOrNull(unixSeconds: number | null | undefined): string | null {
  if (unixSeconds === null || unixSeconds === undefined || unixSeconds === 0) return null;
  return new Date(unixSeconds * 1000).toISOString().replace('.000Z', 'Z');
}

export function humanDuration(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  let rest = Math.abs(Math.round(seconds));
  const days = Math.floor(rest / 86_400);
  rest -= days * 86_400;
  const hours = Math.floor(rest / 3_600);
  rest -= hours * 3_600;
  const minutes = Math.floor(rest / 60);
  rest -= minutes * 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (minutes || hours || days) parts.push(`${minutes}m`);
  parts.push(`${rest}s`);
  return sign + parts.slice(0, 3).join(' ');
}

export interface Column<T> {
  header: string;
  get: (row: T) => string;
  align?: 'left' | 'right';
}

export function renderTable<T>(rows: T[], columns: Array<Column<T>>): string {
  const cells = rows.map((row) => columns.map((column) => column.get(row)));
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...cells.map((line) => line[i]!.length), 0),
  );

  const pad = (text: string, width: number, align: 'left' | 'right') =>
    align === 'right' ? text.padStart(width) : text.padEnd(width);

  const lines = [
    columns.map((column, i) => pad(column.header, widths[i]!, column.align ?? 'left')).join('  '),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...cells.map((line) =>
      line.map((text, i) => pad(text, widths[i]!, columns[i]!.align ?? 'left')).join('  '),
    ),
  ];
  return lines.map((line) => line.trimEnd()).join('\n');
}

/** Multipliers are f64s that matter to the ninth decimal; never let them round to 1. */
export function formatMultiplier(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toFixed(9).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(Math.abs(value) < 10 ? 4 : 2)}%`;
}

export function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

export function flagValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const exact = args.indexOf(`--${name}`);
  if (exact >= 0 && args[exact + 1] && !args[exact + 1]!.startsWith('--')) return args[exact + 1];
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

/** True when this module is the process entry point, on Windows paths too. */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === moduleUrl;
  } catch {
    return false;
  }
}
