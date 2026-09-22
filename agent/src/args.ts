/**
 * A flag parser of its own, rather than `market/src/env.ts`'s.
 *
 * That module also exports `loadKeypair`, which reads a secret key off disk. This
 * agent must be unable to sign, and the cheapest way to guarantee that is for a
 * private key never to enter its module graph in the first place. Twenty lines is a
 * fair price for a property you can check by reading the imports.
 */
export interface Flags {
  has(name: string): boolean;
  str(name: string): string | undefined;
  str(name: string, fallback: string): string;
  num(name: string): number | undefined;
  num(name: string, fallback: number): number;
  list(name: string): number[] | undefined;
}

export function parseArgs(argv: readonly string[] = process.argv.slice(2)): Flags {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) values.set(body.slice(0, eq), body.slice(eq + 1));
    else flags.add(body);
  }
  function str(name: string, fallback?: string): string | undefined {
    return values.get(name) ?? fallback;
  }
  function num(name: string, fallback?: number): number | undefined {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got "${raw}"`);
    return parsed;
  }
  return {
    has: (name) => flags.has(name) || values.has(name),
    str: str as Flags['str'],
    num: num as Flags['num'],
    list: (name) => {
      const raw = values.get(name);
      if (raw === undefined) return undefined;
      return raw.split(',').map((part) => {
        const parsed = Number(part.trim());
        if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a comma-separated list of numbers, got "${raw}"`);
        return parsed;
      });
    },
  };
}
