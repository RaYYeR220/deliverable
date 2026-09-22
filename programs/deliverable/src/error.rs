use anchor_lang::prelude::*;

/// Every reason the program will decline to act on a security.
///
/// These are stable integers: the SDK and the app display them, and a refused
/// transaction is a published artifact, so the numbering does not change.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RefusalCode {
    /// The exchange calendar says the market is shut. Computed on-chain, no oracle.
    MarketClosed = 1,
    /// A halt has been attested for this security.
    Halted = 2,
    /// The price is older than this security's tolerance, inside an open session.
    OracleStale = 3,
    /// Reported confidence is too wide a fraction of the price.
    ConfidenceBlown = 4,
    /// A ScaledUiAmount change is scheduled and has not taken effect yet.
    MultiplierPending = 5,
    /// The issuer has set the mint's Pausable extension.
    IssuerPaused = 6,
    /// A transfer hook program has been attached to the mint since we last looked.
    HookAttached = 7,
    /// Two independent price sources disagree by more than the allowed bound.
    SourcesDisagree = 8,
    /// The security is bound to one price source and nothing corroborates it.
    SingleSource = 9,
    /// A bound price account could not be read at all: an unpublished entry, a
    /// decode failure, or an update past its own outer age bound. Distinct from
    /// [`RefusalCode::OracleStale`], which is a price we could read and would
    /// not act on. Appended rather than renumbered — see the note above.
    OracleUnreadable = 10,
    /// The mint's `ScaledUiAmount` multiplier could not be read or decoded, so
    /// there is no defensible re-cut of the strike.
    MultiplierUnreadable = 11,
}

#[error_code]
pub enum DeliverableError {
    // --- refusals, in RefusalCode order ---
    #[msg("Market is closed for this security")]
    MarketClosed,
    #[msg("Trading in this security is halted")]
    Halted,
    #[msg("Price is stale inside an open session")]
    OracleStale,
    #[msg("Price confidence is too wide to act on")]
    ConfidenceBlown,
    #[msg("A corporate action is pending on this mint")]
    MultiplierPending,
    #[msg("Issuer has paused transfers of this mint")]
    IssuerPaused,
    #[msg("A transfer hook has been attached to this mint")]
    HookAttached,
    #[msg("Price sources disagree beyond the allowed divergence")]
    SourcesDisagree,
    #[msg("Security is bound to a single price source and nothing corroborates it")]
    SingleSource,

    // --- input and arithmetic ---
    #[msg("ScaledUiAmount multiplier is zero, negative, NaN or infinite")]
    InvalidMultiplier,
    #[msg("Fixed-point arithmetic overflowed")]
    MathOverflow,
    #[msg("Mint does not carry the ScaledUiAmount extension")]
    MissingScaledUiAmount,
    #[msg("Oracle account does not match the configured source")]
    OracleSourceMismatch,
    #[msg("Scope price index is out of range")]
    ScopeIndexOutOfRange,

    // --- series lifecycle ---
    #[msg("Expiry does not fall inside a regular trading session")]
    ExpiryNotInSession,
    #[msg("Expiry is already in the past")]
    ExpiryInThePast,
    #[msg("Only covered calls are written by this venue")]
    PutsNotSupported,
    #[msg("Contract size, strike or amount is zero")]
    ZeroAmount,
    #[msg("Series is not in a state that allows this action")]
    WrongSeriesState,
    #[msg("Settlement window has not opened yet")]
    SettlementWindowNotOpen,
    #[msg("Settlement window has closed")]
    SettlementWindowClosed,
    #[msg("Not enough collateral in the vault")]
    InsufficientCollateral,
    #[msg("Premium has already been claimed")]
    PremiumAlreadyClaimed,
    #[msg("Nothing left to settle for this position")]
    NothingToSettle,

    // --- account wiring ---
    #[msg("Account does not belong to this security")]
    SecurityMismatch,
    #[msg("Calendar account is not the one this security is gated by")]
    CalendarMismatch,
    #[msg("Mint does not match the one this account was opened against")]
    MintMismatch,
    #[msg("Calendar has no room for more entries")]
    CalendarFull,

    // --- authority ---
    #[msg("Registry is paused")]
    RegistryPaused,
    #[msg("Signer is not the registry authority")]
    NotAuthority,
    #[msg("Signer is not the registered halt attestor")]
    NotAttestor,
    #[msg("Signer does not own this position")]
    NotPositionOwner,

    // --- appended after the audit; Anchor numbers these positionally, so new
    // variants go at the end and every code above keeps the integer a published
    // failed transaction already carries. ---
    #[msg("Multiplier has moved too far since listing to re-cut the strike")]
    MultiplierOutOfBand,
    #[msg("Oracle account could not be read as the configured source")]
    OracleUnreadable,
    #[msg("Mint multiplier could not be read")]
    MultiplierUnreadable,
    #[msg("Settlement window has not elapsed in actionable minutes yet")]
    SettlementWindowPostponed,
    #[msg("Quote mint and underlying mint must differ")]
    SelfQuotedSeries,
    #[msg("Settlement window is longer than the session clock can measure")]
    SettlementWindowTooLong,
    #[msg("A security must be bound to two distinct price sources")]
    SourcesNotIndependent,
}

impl From<RefusalCode> for DeliverableError {
    fn from(code: RefusalCode) -> Self {
        match code {
            RefusalCode::MarketClosed => DeliverableError::MarketClosed,
            RefusalCode::Halted => DeliverableError::Halted,
            RefusalCode::OracleStale => DeliverableError::OracleStale,
            RefusalCode::ConfidenceBlown => DeliverableError::ConfidenceBlown,
            RefusalCode::MultiplierPending => DeliverableError::MultiplierPending,
            RefusalCode::IssuerPaused => DeliverableError::IssuerPaused,
            RefusalCode::HookAttached => DeliverableError::HookAttached,
            RefusalCode::SourcesDisagree => DeliverableError::SourcesDisagree,
            RefusalCode::SingleSource => DeliverableError::SingleSource,
            RefusalCode::OracleUnreadable => DeliverableError::OracleUnreadable,
            RefusalCode::MultiplierUnreadable => DeliverableError::MultiplierUnreadable,
        }
    }
}
