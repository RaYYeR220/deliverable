# @stocklana/mcp

A stdio [MCP](https://modelcontextprotocol.io) server that lets an agent read the Deliverable rail
and venue. It is built on `@modelcontextprotocol/sdk` 1.30 and `@stocklana/sdk`.

## It cannot sign or send transactions, by design

Every tool on this server is a read. No tool builds, signs or submits a transaction, and the
server never loads a key. It does not have one to load.

That choice follows from what Deliverable is. The program does not rely on its caller to check the
market before acting. It checks for itself and refuses with a typed code: `MarketClosed`, `Halted`,
`MultiplierPending`, and so on. An agent should work the same way. It asks `is_actionable`, gets
told "no" and why, and passes that answer to a human who holds a key. An MCP server that gave the
agent a key would undo that. This one does not, and the tests check it: every tool is annotated
`readOnlyHint: true, destructiveHint: false`, and no input schema accepts a key, signer or
mnemonic.

## Run it

```bash
cd mcp
pnpm install
pnpm build      # builds ../sdk first, then dist/index.js
```

The server needs `SOLANA_RPC_URL`. It reads the variable from the environment first and then from
the repo `.env`. Use an endpoint that allows `getProgramAccounts`; the public mainnet endpoint does
not. The URL is never printed. Logs, which go to stderr, name only the host.

### Client config

Any MCP client that takes an `mcpServers` block:

```json
{
  "mcpServers": {
    "deliverable": {
      "command": "node",
      "args": ["/absolute/path/to/deliverable/mcp/dist/index.js"],
      "env": {
        "SOLANA_RPC_URL": "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"
      }
    }
  }
}
```

On Windows, use forward slashes in `args` (`C:/Users/you/.../mcp/dist/index.js`). You can omit
`env` if the repo `.env` already sets `SOLANA_RPC_URL`.

The server speaks MCP over stdio, so any client that can launch a local command will work; the block
above is the whole integration. Build it first — `dist/` is not committed:

```bash
cd mcp && pnpm install && pnpm build
```

Optional environment:

| variable | default |
|---|---|
| `DELIVERABLE_PROGRAM_ID` | `DnLxRcayAcjUFFuLjobQmJ7K75EgDRGFkUj5tfWcMCaa` |
| `DELIVERABLE_CORPORATE_ACTIONS` | `keeper/data/corporate-actions.json` |

## Tools

Every tool that takes an `underlying` accepts a symbol (`AAPLx`), a bare ticker (`AAPL`) or a mint
address. Symbols come from the keeper's verified seed list and every symbol in its history.

| tool | what it answers |
|---|---|
| `security_state` | Everything the rail knows about one stock right now: the session and the next open, the multiplier in force and any scheduled change, pause and transfer-hook status, both price sources with their ages and divergence, the on-chain `SecurityState` if one exists, and the gate verdict. |
| `is_actionable` | The gate verdict: `actionable: true`, or a code from 1 to 9 with its name, Anchor error number and a plain-English reason. The checks run in the same order as `gate.rs`. |
| `list_series` | Open covered-call series on an underlying. Each has its strike re-derived from the live multiplier (`strike0 × m0 / m1`), its contract size in shares now, its exercise cost per contract and its phase. |
| `series_detail` | One series by address, with its book and vaults. |
| `adjusted_balance` | A multiplier-correct xStock balance for a wallet and xStock, a token account, a total supply, or a transaction's pre/post balances. It shows what the RPC reported next to the corrected figure. |
| `corporate_actions` | Multiplier changes (dividends, splits) recovered by the keeper from mainnet, newest first, with signatures. Given an underlying, it also reads the mint live, catching a change that is scheduled but not yet in force. |
| `refusal_codes` | The nine codes in gate order. |

### What "preview" means

The program is not deployed yet, so there is no on-chain `SecurityState` to read. Until there is,
`is_actionable` and `security_state` evaluate the gate with:

- the committed calendar and the program's default tolerances
- the conventional Scope pair (`Checked` against `PythLazer`)
- the live mint, the live Scope prices and the chain clock

They return `basis: "preview"` and a `notes` list of those assumptions. A halt attestation cannot
exist for an unregistered security, and the notes say so. Once a security is registered, the
same call returns `basis: "registered"` with every input read from chain. Until the program is
deployed, `list_series` returns an empty list with a note saying why.

Here is an example `is_actionable` result, taken at 06:08 ET on a Tuesday:

```json
{
  "actionable": false,
  "code": 1,
  "name": "MarketClosed",
  "reason": "The committed exchange calendar says the US equity market is shut right now ...",
  "anchorErrorCode": 6000,
  "basis": "preview",
  "session": "Closed",
  "nextOpen": "2026-09-22T13:30:00.000Z"
}
```

## Tests

```bash
pnpm typecheck
pnpm test
```

The in-memory tests connect a real MCP `Client` to the server. They check the tool surface, the
read-only annotations and the absence of any signing input, and they run offline. When
`SOLANA_RPC_URL` is set, the suite also runs each tool against the live chain. That includes
correcting the pinned transaction to `439229 / 1e8 × 1.0032690125398187` and confirming the
NFLXx `1 → 10` split against the live mint. A final test spawns `dist/index.js` over stdio,
exactly as the client config above does.
