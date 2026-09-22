const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const INDEX: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET[i]!] = i;

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

export function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array(0);

  const bytes: number[] = [0];
  for (const char of value) {
    const digit = INDEX[char];
    if (digit === undefined) throw new Error(`invalid base58 character ${JSON.stringify(char)}`);
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (let i = 0; i < value.length && value[i] === '1'; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

/** Same as decodeBase58, but returns null instead of throwing. Instruction data from
 *  an untrusted transaction is never guaranteed to be well formed. */
export function tryDecodeBase58(value: string): Uint8Array | null {
  try {
    return decodeBase58(value);
  } catch {
    return null;
  }
}
