# Building

```bash
pnpm install
anchor build --tools-version v1.52 --arch v0
cargo test --manifest-path programs/deliverable/Cargo.toml
```

Those two flags are not decoration. Each one is there because the default fails.

## `--arch v0`

Anchor defaults to `--arch v3`, which emits an SBPFv3 binary. **SBPFv3 deployment is not active on
Solana mainnet** — the relevant feature gates (SIMD-0178, SIMD-0179, SIMD-0189) are still inactive,
while SBPFv0 execution is enabled. Check for yourself:

```bash
solana feature status | grep -i sbpf
```

A `v3` build compiles happily and then fails to deploy, which is an expensive way to find out. If
you are reading this after the gates activate, drop the flag.

## `--tools-version v1.52`

On Windows, a plain `anchor build` downloads platform-tools v1.57 (582 MB) and then dies:

```
Access is denied. (os error 5)
```

The installer cannot replace an existing directory symlink, because Windows holds a mandatory lock
on it. Pinning to v1.52 uses a toolchain that is already unpacked and sidesteps the replacement
entirely. On Linux and macOS the flag is unnecessary.

## `crate-type = ["cdylib"]`, with no `"lib"`

`programs/deliverable/Cargo.toml` deliberately declares only `cdylib`. Adding `"lib"` back is the
single most expensive mistake available in this repository:

| configuration | binary |
|---|---:|
| stock Anchor profile, `["cdylib", "lib"]` | 251,280 B |
| `opt-level="z"`, `strip`, `panic="abort"` | 237,944 B |
| the above, `["cdylib"]` only | **201,856 B** |

Those three figures come from the day-0 build, which carried only a handful of instructions. The
full program, with the rail and the venue, is **428,928 bytes** under the same profile.

`cargo-build-sbf` disables LTO when a `lib` target is present and warns about it in passing. Dropping
`"lib"` recovered 36,088 bytes, which at mainnet rent is about **0.18 SOL** of deploy cost. The
optimisation flags mattered far less than the crate type.

Because there is no `lib` target, unit tests live **inside the crate** under `#[cfg(test)]` rather
than in a top-level `tests/` directory. The IDL still builds normally.

## Dependency pinning

```toml
anchor-lang = "1.2.0"
anchor-spl  = "1.2.0"
pyth-solana-receiver-sdk = "2.0.0"
```

**Do not add `spl-token-2022` or `spl-token-2022-interface = "3"` as a direct dependency.**
`anchor-spl` 1.2.0 resolves `spl-token-2022-interface ^2`; a second, type-incompatible copy makes
`get_mint_extension_data` stop compiling with an error that does not mention versions at all. Reach
the types through the re-export instead:

```rust
use anchor_spl::token_2022::spl_token_2022::extension::scaled_ui_amount::ScaledUiAmountConfig;
```

The current lockfile resolves 432 packages with zero duplicate versions.

## Anchor 1.2 API changes that are easy to trip over

- `CpiContext::new` takes a **`Pubkey`**, not an `AccountInfo`.
- `Context` has **two** lifetimes, not four: `Context<'info, T<'info>>`.
- `LiteSVM` is the default test harness; `solana-test-validator` is not used here and does not start
  on Windows at all (its genesis tarball contains `rocksdb/LOCK` and `CURRENT`, which its own live
  rocksdb holds open, and Windows refuses the overwrite).

## Tests

Tests run under LiteSVM against **real mainnet account dumps** in `tests/fixtures/`. To refresh them:

```bash
pnpm tsx scripts/fixtures.ts <pubkey> tests/fixtures/<name>.bin
```

`SOLANA_RPC_URL` must be set — the public mainnet endpoint rate-limits and blocks
`getProgramAccounts`, which the Scope mapping walk needs. Copy `.env.example` to `.env` and fill it.

## Token-2022 accounts are larger than you expect

An xStock token account is **175 bytes, not 165**: these mints require the `PausableAccount` and
`TransferHookAccount` account extensions, and `TransferHookAccount` is required even though the
hook's `programId` is currently `null`. Anchor's `init` with `token::mint` sizes this correctly on
its own. Always type accounts as `InterfaceAccount<'info, TokenAccount>` and the program as
`Interface<'info, TokenInterface>` — never hardcode a token program id.
