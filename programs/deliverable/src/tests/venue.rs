//! The venue, stood up in LiteSVM against real mainnet accounts.
//!
//! Everything below runs the compiled program: the real AAPLx mint with its
//! real `ScaledUiAmount` multiplier, the real Kamino Scope account with the
//! prices it published on 2026-09-20, and the real USDC mint under the original
//! token program while the collateral sits under Token-2022. Nothing here is a
//! stand-in for something we could not reach.
//!
//! The one thing the tests manufacture is balances: we do not hold AAPLx's mint
//! authority, so a writer's position is seeded by writing a correctly-shaped
//! Token-2022 account — extensions and all — rather than by minting.

use std::path::PathBuf;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack as _;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensionsMut, ExtensionType, StateWithExtensionsMut},
    state::{Account as TokenAccountState, AccountState},
};
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use solana_account::Account as SvmAccount;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey as SvmPubkey;
use solana_signer::Signer as SvmSigner;
use solana_transaction::Transaction;

use crate::constants::{
    CALENDAR_SEED, OPTION_MINT_SEED, PREMIUM_SEED, QUOTE_SEED, REGISTRY_SEED, SCOPE_PRICES,
    SECURITY_SEED, SERIES_SEED, VAULT_SEED, WRITER_SEED,
};
use crate::oracle::{OracleBinding, OracleSource};
use crate::state::{OptionKind, US_EQUITY_2026_2027};

use super::harness::{
    et, mint_account, scope_prices_account_at, usdc_mint_account, AAPLX_MINT,
    SCOPE_AAPLX_CHECKED, SCOPE_AAPLX_LAZER, TOKEN_2022, TOKEN_LEGACY, USDC_MINT,
};

// --- the timeline every venue test shares ---
//
// Expiry lands ten minutes before Friday's close, so the thirty-minute window
// cannot finish that week. Twenty of its minutes are Monday's, which is the
// case a wall-clock window gets wrong and an open-market clock gets right.

/// Thursday 2026-09-17, 11:00 ET. Registration, listing and writing.
pub fn setup_ts() -> i64 {
    et(2026, 9, 17, 11, 0)
}
/// Friday 2026-09-18, 15:50 ET.
pub fn expiry_ts() -> i64 {
    et(2026, 9, 18, 15, 50)
}
/// Sunday 2026-09-20 09:15Z — the moment of the headline measurement.
pub const HERO_TS: i64 = 1_789_895_700;
/// Monday 2026-09-21, 09:40 ET: twenty open-market minutes into the window.
pub fn exercise_ts() -> i64 {
    et(2026, 9, 21, 9, 40)
}
/// Monday 2026-09-21, 10:05 ET: forty-five minutes in, so the window is spent.
pub fn settled_ts() -> i64 {
    et(2026, 9, 21, 10, 5)
}

pub const STRIKE0: u64 = 340_000_000; // $340.00 per UI share, USDC 6dp
pub const CONTRACT_RAW_SIZE: u64 = 100_000_000; // 1e8 raw AAPLx
pub const SETTLEMENT_WINDOW_MINUTES: u16 = 30;

pub const WRITER_AAPLX: u64 = 500_000_000; // five raw shares
pub const HOLDER_USDC: u64 = 1_000_000_000; // $1,000

/// The compiled program.
///
/// Read at run time rather than `include_bytes!`d: the IDL build compiles this
/// crate's tests, so a compile-time dependency on the build output would be
/// circular.
pub fn program_elf() -> Vec<u8> {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop();
    path.pop();
    path.push("target/deploy/deliverable.so");
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "{} is missing ({e}). Build it first: \
             anchor build --tools-version v1.52 --arch v0",
            path.display()
        )
    })
}

pub fn set_clock(svm: &mut LiteSVM, ts: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = ts;
    svm.set_sysvar(&clock);
}

/// Move Scope's publication time to just before `now`, leaving the prices
/// exactly as captured. See [`scope_prices_account_at`].
pub fn stamp_scope(svm: &mut LiteSVM, now: i64) {
    svm.set_account(
        SvmPubkey::from(SCOPE_PRICES.to_bytes()),
        scope_prices_account_at(now - 5),
    )
    .unwrap();
}

/// A token account of the right shape, funded.
///
/// `extensions` is what the mint requires of its accounts: the xStocks need
/// `[PausableAccount, TransferHookAccount]`, which is the 175 bytes that a
/// hand-rolled 165-byte account would get wrong.
pub fn token_account(
    mint: SvmPubkey,
    owner: SvmPubkey,
    amount: u64,
    token_program: SvmPubkey,
    extensions: &[ExtensionType],
) -> SvmAccount {
    let space = if extensions.is_empty() {
        TokenAccountState::LEN
    } else {
        ExtensionType::try_calculate_account_len::<TokenAccountState>(extensions).unwrap()
    };
    let mut data = vec![0u8; space];
    {
        let mut state =
            StateWithExtensionsMut::<TokenAccountState>::unpack_uninitialized(&mut data).unwrap();
        for extension in extensions {
            state.init_account_extension_from_type(*extension).unwrap();
        }
        state.base = TokenAccountState {
            mint: Pubkey::new_from_array(mint.to_bytes()),
            owner: Pubkey::new_from_array(owner.to_bytes()),
            amount,
            delegate: anchor_lang::solana_program::program_option::COption::None,
            state: AccountState::Initialized,
            is_native: anchor_lang::solana_program::program_option::COption::None,
            delegated_amount: 0,
            close_authority: anchor_lang::solana_program::program_option::COption::None,
        };
        state.pack_base();
        state.init_account_type().unwrap();
    }
    SvmAccount {
        lamports: 10_000_000,
        data,
        owner: token_program,
        executable: false,
        rent_epoch: u64::MAX,
    }
}

/// xStock account extensions, as the real mint requires them.
pub const XSTOCK_ACCOUNT_EXTENSIONS: [ExtensionType; 2] = [
    ExtensionType::PausableAccount,
    ExtensionType::TransferHookAccount,
];

pub fn balance_of(svm: &LiteSVM, address: SvmPubkey) -> u64 {
    let account = svm.get_account(&address).expect("token account missing");
    StateWithExtensionsMut::<TokenAccountState>::unpack(&mut account.data.clone())
        .map(|s| s.base.amount)
        .expect("not a token account")
}

pub fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id: SvmPubkey::from(crate::ID.to_bytes()),
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

/// What a helper hands back.
///
/// The failure is boxed and kept whole rather than flattened to an error code:
/// a refused transaction's logs carry the `Refused` event, and that event is
/// the artifact the tests assert on.
pub type TxResult = std::result::Result<TransactionMetadata, Box<FailedTransactionMetadata>>;

pub fn send(
    svm: &mut LiteSVM,
    instructions: &[Instruction],
    payer: &Keypair,
    signers: &[&Keypair],
) -> TxResult {
    let message = Message::new(instructions, Some(&payer.pubkey()));
    let mut all: Vec<&Keypair> = vec![payer];
    all.extend_from_slice(signers);
    let tx = Transaction::new(&all, message, svm.latest_blockhash());
    let result = svm.send_transaction(tx);
    svm.expire_blockhash();
    result.map_err(Box::new)
}

pub fn must_send(
    svm: &mut LiteSVM,
    instructions: &[Instruction],
    payer: &Keypair,
    signers: &[&Keypair],
) -> TransactionMetadata {
    match send(svm, instructions, payer, signers) {
        Ok(meta) => meta,
        Err(failed) => panic!("{:?}\n{}", failed.err, failed.meta.logs.join("\n")),
    }
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &crate::ID).0
}

/// The same 32 bytes, as the program names them.
pub fn anchor_key(key: SvmPubkey) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
}

/// The same 32 bytes, as LiteSVM names them.
pub fn svm_key_of(key: Pubkey) -> SvmPubkey {
    SvmPubkey::from(key.to_bytes())
}

fn svm_key(key: Pubkey) -> SvmPubkey {
    svm_key_of(key)
}

pub fn token_2022_id() -> Pubkey {
    anchor_key(TOKEN_2022)
}

pub fn token_legacy_id() -> Pubkey {
    anchor_key(TOKEN_LEGACY)
}

/// How a venue is stood up. The defaults are the real AAPLx covered call; each
/// test changes at most one thing.
pub struct VenueConfig {
    pub now: i64,
    pub expiry_ts: i64,
    pub strike0: u64,
    pub contract_raw_size: u64,
    pub settlement_window_minutes: u16,
    pub adjust_on_corporate_action: bool,
    /// A security bound to one declared source, which the gate refuses on.
    pub single_source: bool,
}

impl Default for VenueConfig {
    fn default() -> Self {
        Self {
            now: setup_ts(),
            expiry_ts: expiry_ts(),
            strike0: STRIKE0,
            contract_raw_size: CONTRACT_RAW_SIZE,
            settlement_window_minutes: SETTLEMENT_WINDOW_MINUTES,
            adjust_on_corporate_action: true,
            single_source: false,
        }
    }
}

pub struct Venue {
    pub svm: LiteSVM,
    pub authority: Keypair,
    pub attestor: Keypair,
    pub writer: Keypair,
    pub holder: Keypair,

    pub registry: Pubkey,
    pub calendar: Pubkey,
    pub security: Pubkey,
    pub series: Pubkey,
    pub option_mint: Pubkey,
    pub collateral_vault: Pubkey,
    pub premium_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub position: Pubkey,

    pub writer_underlying: SvmPubkey,
    pub writer_option: SvmPubkey,
    pub writer_quote: SvmPubkey,
    pub holder_underlying: SvmPubkey,
    pub holder_option: SvmPubkey,
    pub holder_quote: SvmPubkey,

    pub config: VenueConfig,
}

impl Venue {
    /// Registry, calendar and security only — no series. Used by the tests that
    /// are about the rail rather than the venue.
    pub fn rail(config: VenueConfig) -> Self {
        let mut svm = LiteSVM::new();
        svm.set_account(AAPLX_MINT, mint_account()).unwrap();
        svm.set_account(USDC_MINT, usdc_mint_account()).unwrap();
        svm.add_program(svm_key(crate::ID), &program_elf()).unwrap();
        set_clock(&mut svm, config.now);
        stamp_scope(&mut svm, config.now);

        let authority = Keypair::new();
        let attestor = Keypair::new();
        let writer = Keypair::new();
        let holder = Keypair::new();
        for kp in [&authority, &writer, &holder] {
            svm.airdrop(&kp.pubkey(), 100_000_000_000).unwrap();
        }

        let registry = pda(&[REGISTRY_SEED]);
        let calendar = pda(&[CALENDAR_SEED, &0u16.to_le_bytes()]);
        let underlying = Pubkey::new_from_array(AAPLX_MINT.to_bytes());
        let security = pda(&[SECURITY_SEED, underlying.as_ref()]);

        must_send(
            &mut svm,
            &[
                ix(
                    crate::accounts::InitRegistry {
                        authority: authority.pubkey().to_bytes().into(),
                        registry,
                        system_program: anchor_lang::system_program::ID,
                    },
                    crate::instruction::InitRegistry {
                        attestor: attestor.pubkey().to_bytes().into(),
                    },
                ),
                ix(
                    crate::accounts::InitCalendar {
                        authority: authority.pubkey().to_bytes().into(),
                        registry,
                        calendar,
                        system_program: anchor_lang::system_program::ID,
                    },
                    crate::instruction::InitCalendar {
                        id: 0,
                        regular_open_minute: crate::constants::REGULAR_OPEN_MINUTE,
                        regular_close_minute: crate::constants::REGULAR_CLOSE_MINUTE,
                    },
                ),
                ix(
                    crate::accounts::AppendCalendarEntries {
                        authority: authority.pubkey().to_bytes().into(),
                        calendar,
                    },
                    crate::instruction::AppendCalendarEntries {
                        entries: US_EQUITY_2026_2027.to_vec(),
                    },
                ),
            ],
            &authority,
            &[],
        );

        let sources = if config.single_source {
            OracleBinding::SingleDeclared {
                primary: OracleSource::Scope {
                    index: SCOPE_AAPLX_CHECKED,
                },
            }
        } else {
            OracleBinding::Pair {
                primary: OracleSource::Scope {
                    index: SCOPE_AAPLX_CHECKED,
                },
                secondary: OracleSource::Scope {
                    index: SCOPE_AAPLX_LAZER,
                },
            }
        };

        must_send(
            &mut svm,
            &[ix(
                crate::accounts::RegisterSecurity {
                    authority: authority.pubkey().to_bytes().into(),
                    registry,
                    underlying_mint: underlying,
                    calendar,
                    security,
                    system_program: anchor_lang::system_program::ID,
                },
                crate::instruction::RegisterSecurity {
                    symbol: symbol(b"AAPLx"),
                    sources,
                    max_price_age: crate::constants::DEFAULT_MAX_PRICE_AGE_SECS,
                    max_conf_bps: crate::constants::DEFAULT_MAX_CONF_BPS,
                    max_divergence_bps: crate::constants::DEFAULT_MAX_DIVERGENCE_BPS,
                },
            )],
            &authority,
            &[],
        );

        let series = pda(&[
            SERIES_SEED,
            underlying.as_ref(),
            &config.expiry_ts.to_le_bytes(),
            &config.strike0.to_le_bytes(),
            &[OptionKind::Call as u8],
        ]);

        Venue {
            svm,
            authority,
            attestor,
            writer,
            holder,
            registry,
            calendar,
            security,
            series,
            option_mint: pda(&[OPTION_MINT_SEED, series.as_ref()]),
            collateral_vault: pda(&[VAULT_SEED, series.as_ref()]),
            premium_vault: pda(&[PREMIUM_SEED, series.as_ref()]),
            quote_vault: pda(&[QUOTE_SEED, series.as_ref()]),
            position: Pubkey::default(),
            writer_underlying: SvmPubkey::new_unique(),
            writer_option: SvmPubkey::new_unique(),
            writer_quote: SvmPubkey::new_unique(),
            holder_underlying: SvmPubkey::new_unique(),
            holder_option: SvmPubkey::new_unique(),
            holder_quote: SvmPubkey::new_unique(),
            config,
        }
    }

    /// The rail plus a listed series, funded participants, and the writer's
    /// position opened but empty.
    pub fn listed(config: VenueConfig) -> Self {
        let mut venue = Venue::rail(config);
        venue.list_series();
        venue.fund_participants();
        venue.open_position();
        venue
    }

    /// Everything, plus `contracts` written against real collateral.
    pub fn written(config: VenueConfig, contracts: u64) -> Self {
        let mut venue = Venue::listed(config);
        venue.write(contracts).expect("write failed");
        venue
    }

    pub fn underlying(&self) -> Pubkey {
        Pubkey::new_from_array(AAPLX_MINT.to_bytes())
    }

    pub fn quote(&self) -> Pubkey {
        Pubkey::new_from_array(USDC_MINT.to_bytes())
    }

    pub fn list_series(&mut self) {
        let accounts = crate::accounts::CreateSeries {
            creator: self.authority.pubkey().to_bytes().into(),
            registry: self.registry,
            security: self.security,
            calendar: self.calendar,
            underlying_mint: self.underlying(),
            quote_mint: self.quote(),
            series: self.series,
            option_mint: self.option_mint,
            collateral_vault: self.collateral_vault,
            premium_vault: self.premium_vault,
            quote_vault: self.quote_vault,
            underlying_token_program: Pubkey::new_from_array(TOKEN_2022.to_bytes()),
            quote_token_program: Pubkey::new_from_array(TOKEN_LEGACY.to_bytes()),
            system_program: anchor_lang::system_program::ID,
        };
        let data = crate::instruction::CreateSeries {
            expiry_ts: self.config.expiry_ts,
            strike0: self.config.strike0,
            kind: OptionKind::Call,
            contract_raw_size: self.config.contract_raw_size,
            settlement_window_minutes: self.config.settlement_window_minutes,
            adjust_on_corporate_action: self.config.adjust_on_corporate_action,
        };
        let authority = self.authority.insecure_clone();
        must_send(&mut self.svm, &[ix(accounts, data)], &authority, &[]);
    }

    pub fn fund_participants(&mut self) {
        let option_mint = svm_key(self.option_mint);
        for (owner, underlying, option, quote, aaplx, usdc) in [
            (
                self.writer.pubkey(),
                self.writer_underlying,
                self.writer_option,
                self.writer_quote,
                WRITER_AAPLX,
                0,
            ),
            (
                self.holder.pubkey(),
                self.holder_underlying,
                self.holder_option,
                self.holder_quote,
                0,
                HOLDER_USDC,
            ),
        ] {
            self.svm
                .set_account(
                    underlying,
                    token_account(
                        AAPLX_MINT,
                        owner,
                        aaplx,
                        TOKEN_2022,
                        &XSTOCK_ACCOUNT_EXTENSIONS,
                    ),
                )
                .unwrap();
            self.svm
                .set_account(
                    option,
                    token_account(option_mint, owner, 0, TOKEN_2022, &[]),
                )
                .unwrap();
            self.svm
                .set_account(
                    quote,
                    token_account(USDC_MINT, owner, usdc, TOKEN_LEGACY, &[]),
                )
                .unwrap();
        }
    }

    pub fn open_position(&mut self) {
        self.position = pda(&[
            WRITER_SEED,
            self.series.as_ref(),
            Pubkey::new_from_array(self.writer.pubkey().to_bytes()).as_ref(),
        ]);
        let accounts = crate::accounts::OpenPosition {
            writer: self.writer.pubkey().to_bytes().into(),
            series: self.series,
            position: self.position,
            system_program: anchor_lang::system_program::ID,
        };
        let writer = self.writer.insecure_clone();
        must_send(
            &mut self.svm,
            &[ix(accounts, crate::instruction::OpenPosition {})],
            &writer,
            &[],
        );
    }

    pub fn write_ix(&self, contracts: u64) -> Instruction {
        ix(
            crate::accounts::Write {
                writer: self.writer.pubkey().to_bytes().into(),
                registry: self.registry,
                security: self.security,
                calendar: self.calendar,
                series: self.series,
                underlying_mint: self.underlying(),
                option_mint: self.option_mint,
                collateral_vault: self.collateral_vault,
                writer_underlying: Pubkey::new_from_array(self.writer_underlying.to_bytes()),
                writer_option: Pubkey::new_from_array(self.writer_option.to_bytes()),
                position: self.position,
                primary_oracle: SCOPE_PRICES,
                secondary_oracle: SCOPE_PRICES,
                underlying_token_program: Pubkey::new_from_array(TOKEN_2022.to_bytes()),
            },
            crate::instruction::Write { contracts },
        )
    }

    pub fn write(
        &mut self,
        contracts: u64,
    ) -> TxResult {
        let instruction = self.write_ix(contracts);
        let writer = self.writer.insecure_clone();
        send(&mut self.svm, &[instruction], &writer, &[])
    }

    pub fn exercise_ix(&self, contracts: u64) -> Instruction {
        ix(
            crate::accounts::Exercise {
                holder: self.holder.pubkey().to_bytes().into(),
                registry: self.registry,
                security: self.security,
                calendar: self.calendar,
                series: self.series,
                underlying_mint: self.underlying(),
                quote_mint: self.quote(),
                option_mint: self.option_mint,
                collateral_vault: self.collateral_vault,
                quote_vault: self.quote_vault,
                holder_option: Pubkey::new_from_array(self.holder_option.to_bytes()),
                holder_quote: Pubkey::new_from_array(self.holder_quote.to_bytes()),
                holder_underlying: Pubkey::new_from_array(self.holder_underlying.to_bytes()),
                primary_oracle: SCOPE_PRICES,
                secondary_oracle: SCOPE_PRICES,
                underlying_token_program: Pubkey::new_from_array(TOKEN_2022.to_bytes()),
                quote_token_program: Pubkey::new_from_array(TOKEN_LEGACY.to_bytes()),
            },
            crate::instruction::Exercise { contracts },
        )
    }

    pub fn exercise(
        &mut self,
        contracts: u64,
    ) -> TxResult {
        let instruction = self.exercise_ix(contracts);
        let holder = self.holder.insecure_clone();
        send(&mut self.svm, &[instruction], &holder, &[])
    }

    pub fn settle_expired(
        &mut self,
    ) -> TxResult {
        let instruction = ix(
            crate::accounts::SettleExpired {
                writer: self.writer.pubkey().to_bytes().into(),
                calendar: self.calendar,
                series: self.series,
                position: self.position,
                underlying_mint: self.underlying(),
                quote_mint: self.quote(),
                collateral_vault: self.collateral_vault,
                quote_vault: self.quote_vault,
                writer_underlying: Pubkey::new_from_array(self.writer_underlying.to_bytes()),
                writer_quote: Pubkey::new_from_array(self.writer_quote.to_bytes()),
                underlying_token_program: Pubkey::new_from_array(TOKEN_2022.to_bytes()),
                quote_token_program: Pubkey::new_from_array(TOKEN_LEGACY.to_bytes()),
            },
            crate::instruction::SettleExpired {},
        );
        let writer = self.writer.insecure_clone();
        send(&mut self.svm, &[instruction], &writer, &[])
    }

    pub fn claim_premium(
        &mut self,
    ) -> TxResult {
        let instruction = ix(
            crate::accounts::ClaimPremium {
                writer: self.writer.pubkey().to_bytes().into(),
                series: self.series,
                position: self.position,
                underlying_mint: self.underlying(),
                premium_vault: self.premium_vault,
                writer_underlying: Pubkey::new_from_array(self.writer_underlying.to_bytes()),
                underlying_token_program: Pubkey::new_from_array(TOKEN_2022.to_bytes()),
            },
            crate::instruction::ClaimPremium {},
        );
        let writer = self.writer.insecure_clone();
        send(&mut self.svm, &[instruction], &writer, &[])
    }

    pub fn sync_security(
        &mut self,
    ) -> TxResult {
        let instruction = ix(
            crate::accounts::ReadSecurity {
                security: self.security,
                underlying_mint: self.underlying(),
                primary_oracle: SCOPE_PRICES,
                secondary_oracle: SCOPE_PRICES,
            },
            crate::instruction::SyncSecurity {},
        );
        let authority = self.authority.insecure_clone();
        send(&mut self.svm, &[instruction], &authority, &[])
    }

    pub fn probe_security(
        &mut self,
    ) -> TxResult {
        let instruction = ix(
            crate::accounts::ProbeSecurity {
                security: self.security,
                calendar: self.calendar,
                underlying_mint: self.underlying(),
                primary_oracle: SCOPE_PRICES,
                secondary_oracle: SCOPE_PRICES,
            },
            crate::instruction::ProbeSecurity {},
        );
        let authority = self.authority.insecure_clone();
        send(&mut self.svm, &[instruction], &authority, &[])
    }

    /// Premium arrives as a plain transfer into the vault, which is what a
    /// Meteora fee claim on a stock-quoted pool looks like from here.
    pub fn deposit_premium(&mut self, amount: u64) {
        let vault = svm_key(self.premium_vault);
        let current = balance_of(&self.svm, vault);
        let mut account = self.svm.get_account(&vault).unwrap();
        let series = svm_key(self.series);
        account.data = token_account(
            AAPLX_MINT,
            series,
            current + amount,
            TOKEN_2022,
            &XSTOCK_ACCOUNT_EXTENSIONS,
        )
        .data;
        self.svm.set_account(vault, account).unwrap();
    }

    /// The option changes hands. On mainnet this is a Meteora swap; here it is
    /// the transfer that swap would have made, so the holder who exercises is
    /// not the writer who is assigned.
    pub fn hand_option_to_holder(&mut self, contracts: u64) {
        let option_mint = svm_key(self.option_mint);
        let held = balance_of(&self.svm, self.writer_option);
        self.svm
            .set_account(
                self.writer_option,
                token_account(
                    option_mint,
                    self.writer.pubkey(),
                    held - contracts,
                    TOKEN_2022,
                    &[],
                ),
            )
            .unwrap();
        let has = balance_of(&self.svm, self.holder_option);
        self.svm
            .set_account(
                self.holder_option,
                token_account(
                    option_mint,
                    self.holder.pubkey(),
                    has + contracts,
                    TOKEN_2022,
                    &[],
                ),
            )
            .unwrap();
    }

    pub fn calendar_state(&self) -> crate::state::MarketCalendar {
        let account = self.svm.get_account(&svm_key(self.calendar)).unwrap();
        crate::state::MarketCalendar::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    pub fn at(&mut self, ts: i64) {
        set_clock(&mut self.svm, ts);
        stamp_scope(&mut self.svm, ts);
    }

    pub fn security_state(&self) -> crate::state::SecurityState {
        let account = self.svm.get_account(&svm_key(self.security)).unwrap();
        crate::state::SecurityState::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    pub fn series_state(&self) -> crate::state::OptionSeries {
        let account = self.svm.get_account(&svm_key(self.series)).unwrap();
        crate::state::OptionSeries::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    pub fn position_state(&self) -> crate::state::WriterPosition {
        let account = self.svm.get_account(&svm_key(self.position)).unwrap();
        crate::state::WriterPosition::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

}

pub fn symbol(text: &[u8]) -> [u8; 12] {
    let mut out = [0u8; 12];
    out[..text.len()].copy_from_slice(text);
    out
}

/// The refusal code carried by a `Refused` event in a transaction's logs.
///
/// `emit!` writes the event as base64 under `Program data:`; the payload is an
/// eight-byte discriminator, then the security, then the code. Reading it back
/// is how a test asserts on the artifact a judge would click, rather than on
/// the error the transaction happened to return.
pub fn refusal_code_in_logs(logs: &[String]) -> Option<u8> {
    use anchor_lang::Discriminator;

    for line in logs {
        let Some(encoded) = line.strip_prefix("Program data: ") else {
            continue;
        };
        let Some(bytes) = base64_decode(encoded.trim()) else {
            continue;
        };
        if bytes.len() == 8 + 32 + 1 + 8 && bytes[..8] == *crate::gate::Refused::DISCRIMINATOR {
            return Some(bytes[8 + 32]);
        }
    }
    None
}

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for byte in input.bytes() {
        if byte == b'=' {
            break;
        }
        let value = TABLE.iter().position(|c| *c == byte)? as u32;
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}
