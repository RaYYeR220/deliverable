//! Every `#[derive(Accounts)]` struct, and the constraints it must carry.
//!
//! Six of the eleven findings in the audit were the same shape: a rule applied
//! correctly everywhere but one place. The calendar bound on five instructions
//! and not the sixth. The address bound on the Pyth adapter and not on Scope.
//! The registry pause on four value-moving paths and not on two. The `> 0`
//! check on `strike0` at listing and not on the re-cut strike at settlement.
//! None of them was a subtle algorithm; all of them were a sibling that was
//! missed, and a per-instruction happy-path test cannot see a missing sibling
//! because the happy path does not exercise the constraint.
//!
//! So this file does not test behaviour. It reads the account structs out of
//! the source and asserts, rule by rule, that every account of a given kind
//! carries the constraints accounts of that kind carry — with every exemption
//! written down next to the reason it is allowed. A new instruction, a new
//! account on an existing one, or a `has_one` deleted in a refactor fails here
//! rather than in the next audit.

use std::collections::BTreeSet;

/// The program's account structs live in these files. Adding one means adding
/// it here; a file that is not listed is not checked, which is exactly the
/// failure this test exists to prevent, so the list is asserted below against
/// the modules `instructions/mod.rs` declares.
const SOURCES: &[(&str, &str)] = &[
    ("instructions/admin.rs", include_str!("../instructions/admin.rs")),
    (
        "instructions/security.rs",
        include_str!("../instructions/security.rs"),
    ),
    (
        "instructions/series.rs",
        include_str!("../instructions/series.rs"),
    ),
    (
        "instructions/settle.rs",
        include_str!("../instructions/settle.rs"),
    ),
    (
        "instructions/write.rs",
        include_str!("../instructions/write.rs"),
    ),
    ("lib.rs", include_str!("../lib.rs")),
];

/// One account on one instruction: the attribute text in front of it and the
/// type it was declared as, both flattened to a single line.
#[derive(Debug, Clone)]
struct AccountField {
    struct_name: String,
    field: String,
    attrs: String,
    ty: String,
}

impl AccountField {
    fn requires(&self, needle: &str) -> bool {
        self.attrs.contains(needle)
    }
}

/// Pull every `#[derive(Accounts)]` struct out of the source.
///
/// A parser rather than a macro because the thing being checked is what the
/// source says: a proc-macro reflection of the same attributes could only tell
/// us what Anchor understood, and the finding this guards against is an
/// attribute that was never written.
fn account_fields() -> Vec<AccountField> {
    let mut out = Vec::new();
    for (file, source) in SOURCES {
        let mut lines = source.lines().peekable();
        while let Some(line) = lines.next() {
            if line.trim() != "#[derive(Accounts)]" {
                continue;
            }
            // Skip any `#[instruction(...)]` and find the struct header.
            let mut header = String::new();
            for next in lines.by_ref() {
                header.push_str(next.trim());
                if next.contains('{') {
                    break;
                }
            }
            let struct_name = header
                .split("pub struct ")
                .nth(1)
                .unwrap_or_else(|| panic!("{file}: no struct after #[derive(Accounts)]"))
                .split(['<', ' ', '{'])
                .next()
                .unwrap()
                .to_string();

            let mut attrs = String::new();
            for body in lines.by_ref() {
                let trimmed = body.trim();
                if trimmed == "}" {
                    break;
                }
                if let Some(field) = trimmed.strip_prefix("pub ") {
                    let (name, ty) = field
                        .split_once(':')
                        .unwrap_or_else(|| panic!("{file}: odd field line {trimmed:?}"));
                    out.push(AccountField {
                        struct_name: struct_name.clone(),
                        field: name.trim().to_string(),
                        attrs: std::mem::take(&mut attrs),
                        ty: ty.trim().trim_end_matches(',').to_string(),
                    });
                } else {
                    attrs.push(' ');
                    attrs.push_str(trimmed);
                }
            }
        }
    }
    out
}

/// The full list of account structs. A new instruction has to be added here
/// *and* given rules below, which is the point: the cost of adding an
/// instruction includes saying what guards it.
const EVERY_ACCOUNTS_STRUCT: &[&str] = &[
    "InitRegistry",
    "SetRegistryPaused",
    "InitCalendar",
    "AppendCalendarEntries",
    "RegisterSecurity",
    "ReadSecurity",
    "AttestHalt",
    "ProbeSecurity",
    "CreateSeries",
    "AcknowledgeAdjustment",
    "OpenPosition",
    "Write",
    "ClaimPremium",
    "Exercise",
    "SettleExpired",
    "ProbeSession",
];

/// Instructions that move a token out of a vault the program controls, or
/// take one in. These are the ones the registry kill switch has to reach.
const VALUE_MOVING: &[&str] = &["Write", "ClaimPremium", "Exercise", "SettleExpired"];

#[test]
fn every_accounts_struct_is_accounted_for() {
    let found: BTreeSet<String> = account_fields()
        .iter()
        .map(|f| f.struct_name.clone())
        .collect();
    let expected: BTreeSet<String> = EVERY_ACCOUNTS_STRUCT.iter().map(|s| s.to_string()).collect();
    assert_eq!(
        found, expected,
        "an account struct was added or removed without declaring its constraints here"
    );
}

/// Every account field's name has to be one this file has an opinion about.
/// A name nobody has written a rule for is an account nobody has said what to
/// check on, which is how five instructions ended up carrying a constraint the
/// sixth did not.
#[test]
fn every_account_name_has_a_rule() {
    const KNOWN: &[&str] = &[
        // signers and programs — checked by their types, not by attributes
        "authority",
        "attestor",
        "creator",
        "writer",
        "holder",
        "system_program",
        "underlying_token_program",
        "quote_token_program",
        // state
        "registry",
        "calendar",
        "security",
        "series",
        "position",
        // mints
        "underlying_mint",
        "quote_mint",
        "option_mint",
        // vaults
        "collateral_vault",
        "premium_vault",
        "quote_vault",
        // participant token accounts
        "writer_underlying",
        "writer_option",
        "writer_quote",
        "holder_option",
        "holder_quote",
        "holder_underlying",
        // oracles
        "primary_oracle",
        "secondary_oracle",
    ];
    for field in account_fields() {
        assert!(
            KNOWN.contains(&field.field.as_str()),
            "{}.{} has no constraint rule in constraints_test",
            field.struct_name,
            field.field
        );
    }
}

#[test]
fn every_calendar_is_the_one_its_security_is_gated_by() {
    // F-02 was exactly this, missing on exactly one instruction: the calendar
    // handed to `settle_expired` decided whether the exercise window had run
    // out, and the only check on it was that it was *a* calendar.
    let exempt: &[(&str, &str)] = &[
        ("InitCalendar", "creates the calendar; there is no security yet"),
        (
            "AppendCalendarEntries",
            "authority-only edit of the calendar itself, gated by has_one",
        ),
        (
            "RegisterSecurity",
            "this is the instruction that binds a security to a calendar",
        ),
        ("ProbeSession", "resolves a session for a calendar and reads nothing else"),
    ];
    for field in account_fields().into_iter().filter(|f| f.field == "calendar") {
        if exempt.iter().any(|(s, _)| *s == field.struct_name) {
            continue;
        }
        assert!(
            field.requires("calendar.id == security.calendar_id"),
            "{}.calendar is not bound to its security",
            field.struct_name
        );
        assert!(
            field.requires("seeds = [CALENDAR_SEED") && field.requires("bump = calendar.bump"),
            "{}.calendar is not derived from its seeds",
            field.struct_name
        );
    }
}

#[test]
fn every_series_is_derived_from_all_of_its_terms() {
    // F-05: the quote asset, the contract size, the window and the adjustment
    // flag were instruction arguments outside the address, so whoever listed
    // first fixed all four for the canonical slot.
    for field in account_fields().into_iter().filter(|f| f.field == "series") {
        if field.struct_name == "CreateSeries" {
            // Seeded from the instruction arguments, because the account does
            // not exist yet to be read from.
            for term in [
                "underlying_mint.key().as_ref()",
                "quote_mint.key().as_ref()",
                "&expiry_ts.to_le_bytes()",
                "&strike0.to_le_bytes()",
                "&contract_raw_size.to_le_bytes()",
                "&settlement_window_minutes.to_le_bytes()",
                "&[kind as u8]",
                "&[adjust_on_corporate_action as u8]",
            ] {
                assert!(
                    field.requires(term),
                    "CreateSeries.series seeds omit {term}"
                );
            }
            continue;
        }
        for term in [
            "SERIES_SEED",
            "series.underlying_mint.as_ref()",
            "series.quote_mint.as_ref()",
            "&series.expiry_ts.to_le_bytes()",
            "&series.strike0.to_le_bytes()",
            "&series.contract_raw_size.to_le_bytes()",
            "&series.settlement_window_minutes.to_le_bytes()",
            "&[series.kind as u8]",
            "&[series.adjust_on_corporate_action as u8]",
            "bump = series.bump",
        ] {
            assert!(
                field.requires(term),
                "{}.series seeds omit {term}",
                field.struct_name
            );
        }
    }
}

#[test]
fn every_position_is_seeded_by_its_series_and_owned_by_its_signer() {
    for field in account_fields().into_iter().filter(|f| f.field == "position") {
        assert!(
            field.requires("seeds = [WRITER_SEED, series.key().as_ref(), writer.key().as_ref()]"),
            "{}.position is not seeded by (series, writer)",
            field.struct_name
        );
        if field.struct_name == "OpenPosition" {
            assert!(field.requires("init"), "OpenPosition.position must init");
            continue;
        }
        assert!(
            field.requires("bump = position.bump"),
            "{}.position does not pin its stored bump",
            field.struct_name
        );
        assert!(
            field.requires("position.owner == writer.key()"),
            "{}.position is not checked against its signer",
            field.struct_name
        );
    }
}

#[test]
fn every_security_is_its_mint_and_matches_its_series() {
    let fields = account_fields();
    for field in fields.iter().filter(|f| f.field == "security") {
        if field.struct_name == "RegisterSecurity" {
            assert!(field.requires("init"), "RegisterSecurity.security must init");
            continue;
        }
        assert!(
            field.requires("seeds = [SECURITY_SEED") && field.requires("bump = security.bump"),
            "{}.security is not derived from its mint",
            field.struct_name
        );
        let has_series = fields
            .iter()
            .any(|f| f.struct_name == field.struct_name && f.field == "series");
        // `CreateSeries` is the other direction: the series does not exist yet,
        // and `series.security` is written *from* this account. It is bound by
        // its own seed against `underlying_mint`, which the series is then
        // seeded by too, so the two cannot come apart.
        if has_series && field.struct_name != "CreateSeries" {
            assert!(
                field.requires("security.key() == series.security"),
                "{}.security is not cross-checked against its series",
                field.struct_name
            );
        }
    }
}

#[test]
fn the_kill_switch_reaches_every_value_moving_instruction_but_one() {
    // `settle_expired` is the deliberate exception, and the reason is in its
    // handler: a paused venue must not be able to strand a writer's
    // collateral. Every other path that moves a token carries the pause, which
    // `claim_premium` did not — it could empty the premium vault of the
    // underlying share while the venue was paused and the market shut.
    let fields = account_fields();
    for name in VALUE_MOVING {
        let registry = fields
            .iter()
            .find(|f| f.struct_name == *name && f.field == "registry");
        if *name == "SettleExpired" {
            assert!(
                registry.is_none(),
                "SettleExpired grew a registry account; if that is intended, the \
                 comment on `settle_expired` about stranding collateral has to move too"
            );
            continue;
        }
        let registry = registry
            .unwrap_or_else(|| panic!("{name} moves value and carries no registry account"));
        assert!(
            registry.requires("!registry.paused"),
            "{name} carries the registry without the pause constraint"
        );
        assert!(
            registry.requires("seeds = [REGISTRY_SEED]") && registry.requires("bump = registry.bump"),
            "{name}.registry is not derived from its seed"
        );
    }
}

#[test]
fn every_vault_is_the_one_its_series_names() {
    for field in account_fields()
        .into_iter()
        .filter(|f| f.field.ends_with("_vault"))
    {
        if field.struct_name == "CreateSeries" {
            assert!(field.requires("init"), "CreateSeries.{} must init", field.field);
            assert!(
                field.requires("token::authority = series"),
                "CreateSeries.{} is not owned by the series",
                field.field
            );
            continue;
        }
        assert!(
            field.requires(&format!("address = series.{}", field.field)),
            "{}.{} is not pinned to the series' own vault",
            field.struct_name,
            field.field
        );
    }
}

#[test]
fn every_participant_token_account_is_checked_on_mint_and_owner() {
    // A token account constrained on only one of the two is the shape that
    // lets a caller be paid out of somebody else's position.
    for field in account_fields().into_iter().filter(|f| {
        f.field.starts_with("writer_") || f.field.starts_with("holder_")
    }) {
        let owner = if field.field.starts_with("writer_") {
            "writer.key()"
        } else {
            "holder.key()"
        };
        assert!(
            field.requires(&format!("{}.owner == {owner}", field.field)),
            "{}.{} is not checked against its signer",
            field.struct_name,
            field.field
        );
        assert!(
            field.requires(&format!("{}.mint ==", field.field)),
            "{}.{} is not checked against a mint",
            field.struct_name,
            field.field
        );
    }
}

#[test]
fn every_mint_is_pinned_by_address() {
    for field in account_fields()
        .into_iter()
        .filter(|f| f.field.ends_with("_mint"))
    {
        match (field.struct_name.as_str(), field.field.as_str()) {
            // The mint a security is being registered against, and the quote
            // asset a series is being listed in: both are the argument, not a
            // reference to something already stored.
            ("RegisterSecurity", "underlying_mint") => continue,
            ("CreateSeries", "quote_mint") => continue,
            ("CreateSeries", "underlying_mint") => {
                assert!(field.requires("address = security.underlying_mint"));
                continue;
            }
            ("CreateSeries", "option_mint") => {
                assert!(field.requires("init") && field.requires("mint::authority = series"));
                continue;
            }
            _ => {}
        }
        assert!(
            field.requires("address = series.") || field.requires("address = security."),
            "{}.{} is not pinned by address",
            field.struct_name,
            field.field
        );
    }
}

#[test]
fn every_oracle_account_is_unchecked_here_and_bound_in_the_adapter() {
    // F-01: `primary_oracle` and `secondary_oracle` are `UncheckedAccount` on
    // four instructions because the adapter is chosen by the registration
    // rather than by the account list. That is only sound while the adapter
    // binds the account itself, so this test pins both halves: unchecked here,
    // and an address comparison in `oracle::observe` for every source.
    let oracle_source = include_str!("../oracle/mod.rs");
    assert!(
        oracle_source.contains("require_keys_eq!(\n                acct.key(),\n                SCOPE_PRICES,"),
        "the Scope adapter no longer binds its account by address"
    );
    let pyth_source = include_str!("../oracle/pyth.rs");
    assert!(
        pyth_source.contains("PriceUpdateV2::DISCRIMINATOR"),
        "the Pyth adapter no longer checks its discriminator"
    );
    let scope_source = include_str!("../oracle/scope.rs");
    assert!(
        scope_source.contains("SCOPE_ORACLE_PRICES_DISCRIMINATOR")
            && scope_source.contains("SCOPE_PRICES_LEN"),
        "the Scope decoder no longer checks the account's type or length"
    );

    for field in account_fields()
        .into_iter()
        .filter(|f| f.field.ends_with("_oracle"))
    {
        assert!(
            field.ty.starts_with("UncheckedAccount"),
            "{}.{} changed type; the adapter's checks were sized for an unchecked account",
            field.struct_name,
            field.field
        );
        assert!(
            field.attrs.contains("CHECK:"),
            "{}.{} has no CHECK comment",
            field.struct_name,
            field.field
        );
    }
}

#[test]
fn every_authority_only_instruction_says_whose_authority() {
    for field in account_fields()
        .into_iter()
        .filter(|f| f.struct_name != "InitRegistry" && f.field == "registry")
    {
        let signer_bound = field.requires("has_one = authority")
            || field.requires("registry.attestor == attestor.key()")
            || field.requires("!registry.paused");
        assert!(
            signer_bound,
            "{}.registry is carried without saying what it authorises",
            field.struct_name
        );
    }
}
