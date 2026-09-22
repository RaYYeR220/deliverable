import { short } from '@/lib/format';
import type { Segment } from '@/lib/types';

export function Segments({ parts }: { parts: Segment[] }) {
  return (
    <>
      {parts.map((part, i) =>
        part.href ? (
          <a key={i} href={part.href} className="i-link" target="_blank" rel="noreferrer">
            {part.text}
          </a>
        ) : part.mono ? (
          <span key={i} className="i-mono">
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** An address, shortened, linked to its explorer page. */
export function Addr({ address, href, full = false }: { address: string; href: string; full?: boolean }) {
  const shown = full ? address : short(address);
  return (
    <a href={href} className="i-link" target="_blank" rel="noreferrer" title={address}>
      {shown}
    </a>
  );
}
