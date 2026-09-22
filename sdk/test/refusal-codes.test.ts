import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as generated from '../src/generated/index.js';
import { GATE_CHECK_ORDER, REFUSALS, RefusalCode, refusalFromErrorCode } from '../src/refusal.js';
import { programSource, SDK_ROOT } from './helpers.js';

interface IdlError {
  code: number;
  name: string;
  msg: string;
}

const idl = JSON.parse(readFileSync(resolve(SDK_ROOT, 'idl', 'deliverable.json'), 'utf8')) as { errors: IdlError[] };
const errorRs = programSource('error.rs');
const gateRs = programSource('gate.rs');

const snake = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();

describe('refusal codes match error.rs', () => {
  it('RefusalCode discriminants are the integers the program publishes', ({ skip }) => {
    if (!errorRs) return skip('programs/deliverable/src/error.rs is not beside this checkout');
    const body = /pub enum RefusalCode\s*\{([\s\S]*?)\n\}/.exec(errorRs)?.[1];
    expect(body, 'RefusalCode enum not found in error.rs').toBeDefined();
    const variants = [...body!.matchAll(/^\s*(\w+)\s*=\s*(\d+),/gm)].map((m) => [m[1]!, Number(m[2])] as const);

    // Nine gate conditions plus the two read failures the probe records.
    expect(variants).toHaveLength(11);
    expect(Object.fromEntries(variants)).toEqual(RefusalCode);
    for (const [name, code] of variants) {
      expect(REFUSALS[code as keyof typeof REFUSALS].name).toBe(name);
    }
  });

  it('the first nine DeliverableError variants are the refusals, in code order, with the same messages', ({ skip }) => {
    if (!errorRs) return skip('programs/deliverable/src/error.rs is not beside this checkout');
    const body = /pub enum DeliverableError\s*\{([\s\S]*?)\n\}/.exec(errorRs)?.[1];
    const variants = [...body!.matchAll(/#\[msg\("([^"]*)"\)\]\s*(\w+),/g)].map((m) => ({ msg: m[1]!, name: m[2]! }));
    for (let code = 1; code <= 9; code++) {
      const info = REFUSALS[code as keyof typeof REFUSALS];
      expect(variants[code - 1]).toEqual({ name: info.name, msg: info.message });
    }
  });

  it('agrees with the IDL error table, which is what a failed transaction carries', () => {
    for (const info of Object.values(REFUSALS)) {
      const idlError = idl.errors.find((e) => e.code === info.errorCode);
      expect(idlError, info.name).toEqual({ code: info.errorCode, name: info.name, msg: info.message });
      expect(refusalFromErrorCode(info.errorCode)).toBe(info);
    }
    // 6009 is InvalidMultiplier: an error, not a refusal. The two appended
    // refusals carry their own error numbers rather than 6009 and 6010, because
    // Anchor numbers its variants positionally and the nine above them are
    // published integers that cannot move.
    expect(refusalFromErrorCode(6009)).toBeUndefined();
    expect(refusalFromErrorCode(5999)).toBeUndefined();
  });

  it('agrees with the Codama-generated error constants', () => {
    const constants = generated as unknown as Record<string, unknown>;
    for (const info of Object.values(REFUSALS)) {
      expect(constants[`DELIVERABLE_ERROR__${snake(info.name)}`]).toBe(info.errorCode);
    }
  });

  it('GATE_CHECK_ORDER is the order check_actionable evaluates in gate.rs', ({ skip }) => {
    if (!gateRs) return skip('programs/deliverable/src/gate.rs is not beside this checkout');
    const fn = /pub fn check_actionable[\s\S]*?\n\}/.exec(gateRs)?.[0];
    expect(fn, 'check_actionable not found in gate.rs').toBeDefined();
    const order = [...fn!.matchAll(/refuse\(RefusalCode::(\w+)\)/g)].map((m) => m[1]!);
    // OracleStale and ConfidenceBlown appear twice (primary, then secondary); keep first sight.
    expect([...new Set(order)]).toEqual([...GATE_CHECK_ORDER]);
  });
});
