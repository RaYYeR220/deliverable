// Regenerates src/generated from the Anchor IDL with Codama.
//
// Anchor's own TypeScript client is built on web3.js v1 and cannot produce Kit
// instructions, so the typed builders, account decoders and PDA helpers all come
// from the IDL through Codama instead. The IDL under target/ is preferred when a
// fresh `anchor build` has produced one; idl/deliverable.json is the committed copy
// so a checkout without a Rust toolchain can still regenerate.
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..');
const COMMITTED = resolve(PACKAGE, 'idl', 'deliverable.json');
const BUILT = resolve(PACKAGE, '..', 'target', 'idl', 'deliverable.json');

if (existsSync(BUILT)) {
  copyFileSync(BUILT, COMMITTED);
  console.log(`idl: ${BUILT} -> idl/deliverable.json`);
} else {
  console.log('idl: target/idl/deliverable.json not found, using the committed idl/deliverable.json');
}

const idl = JSON.parse(readFileSync(COMMITTED, 'utf8'));
const codama = createFromRoot(rootNodeFromAnchor(idl));

await codama.accept(
  renderVisitor(PACKAGE, {
    generatedFolder: 'src/generated',
    importExtension: 'js',
    erasableSyntax: true,
    kitImportStrategy: 'rootOnly',
    syncPackageJson: false,
  }),
);

console.log('generated: src/generated');
