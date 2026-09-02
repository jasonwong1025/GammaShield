// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Approval {
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IShadowFill {
    struct ShadowQuote {
        bytes32 fillId;
        bytes32 sourceHash;
        bytes32 asset;
        address buyer;
        bool isCall;
        uint128 strikeE8;
        uint64 expiry;
        uint64 validUntil;
        uint128 contractsE6;
        uint128 premiumUsdc;
    }

    struct ShadowClose {
        bytes32 closeId;
        uint256 positionId;
        address seller;
        uint64 validUntil;
        uint128 contractsE6;
        uint128 proceedsUsdc;
    }

    function fillShadow(ShadowQuote calldata quote, bytes calldata signature) external returns (uint256 positionId);
    function closeShadow(ShadowClose calldata close, bytes calldata signature) external returns (uint128 proceedsUsdc);
}

interface IThetanutsOptionBook {
    struct Order {
        address maker;
        uint256 orderExpiryTimestamp;
        address collateral;
        bool isCall;
        address priceFeed;
        address implementation;
        bool isLong;
        uint256 maxCollateralUsable;
        uint256[] strikes;
        uint256 expiry;
        uint256 price;
        uint256 numContracts;
        bytes extraOptionData;
    }

    function fillOrder(Order calldata order, bytes calldata signature, address referrer) external returns (address optionAddress);
}

/// @dev ERC-4337 v0.7 packed user operation, kept local to avoid coupling the
/// demonstration contract to a particular account-abstraction package.
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/// @notice A Base Sepolia ERC-4337 account where an agent can submit only a
/// registered, bounded shadow fill. The owner registers, pauses, or revokes
/// policies directly; the account can only move funds through the EntryPoint.
contract MandateAccount {
    struct Mandate {
        address owner;
        address account;
        address agent;
        address optionBook;
        address collateral;
        bytes32 asset;
        uint8 side;
        uint256 maxPremiumPerFill;
        uint256 maxPremiumTotal;
        uint256 maxContractsPerFill;
        uint64 minTenorSeconds;
        uint64 maxTenorSeconds;
        uint16 riskThresholdBps;
        uint64 persistenceSeconds;
        uint64 minExecutionIntervalSeconds;
        uint64 validAfter;
        uint64 expiresAt;
        uint256 nonce;
    }

    struct RiskAttestation {
        bytes32 mandateHash;
        uint16 riskScoreBps;
        uint64 observedAt;
        uint64 validUntil;
        uint64 persistenceSeconds;
    }

    struct ThetanutsQuote {
        bytes32 mandateHash;
        bytes32 fillCalldataHash;
        uint256 premium;
        uint256 contracts;
        uint64 observedAt;
        uint64 validUntil;
    }

    /// @notice The agent's attestation that this exit mark is the one it
    /// reviewed. Bound to a mandate so a close signed for one policy cannot be
    /// replayed against another.
    struct ShadowCloseAttestation {
        bytes32 mandateHash;
        bytes32 closeId;
        uint256 positionId;
        uint128 contractsE6;
        uint128 proceedsUsdc;
        uint64 observedAt;
        uint64 validUntil;
    }

    /// @notice Everything one atomic roll needs, bundled so the call stays
    /// within the legacy code generator's stack limit.
    struct RollRequest {
        RiskAttestation risk;
        bytes riskSignature;
        ShadowCloseAttestation attestation;
        bytes attestationSignature;
        IShadowFill.ShadowClose close;
        bytes closeSignature;
        IShadowFill.ShadowQuote quote;
        bytes quoteSignature;
    }

    struct MandateControl {
        bool paused;
        bool revoked;
        uint256 spentPremium;
        uint64 lastExecutionAt;
    }

    struct RiskState {
        uint16 scoreBps;
        uint64 eligibleSince;
        uint64 observedAt;
        uint64 validUntil;
    }

    uint256 private constant SIG_VALIDATION_FAILED = 1;
    uint64 private constant MAX_RISK_OBSERVATION_AGE = 3 minutes;
    uint64 private constant MAX_THETANUTS_QUOTE_AGE = 3 minutes;
    address private constant BASE_OPTION_BOOK = 0x1bDff855d6811728acaDC00989e79143a2bdfDed;
    address private constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address private constant BASE_ETH_FEED = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address private constant BASE_BTC_FEED = 0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F;
    address private constant BASE_PUT_IMPLEMENTATION = 0x7355EB92dfb0503DB558a70c10843618932ab290;
    uint256 private constant SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant MANDATE_TYPEHASH = keccak256(
        "Mandate(address owner,address account,address agent,address optionBook,address collateral,bytes32 asset,uint8 side,uint256 maxPremiumPerFill,uint256 maxPremiumTotal,uint256 maxContractsPerFill,uint64 minTenorSeconds,uint64 maxTenorSeconds,uint16 riskThresholdBps,uint64 persistenceSeconds,uint64 minExecutionIntervalSeconds,uint64 validAfter,uint64 expiresAt,uint256 nonce)"
    );
    bytes32 private constant RISK_TYPEHASH = keccak256(
        "RiskAttestation(bytes32 mandateHash,uint16 riskScoreBps,uint64 observedAt,uint64 validUntil,uint64 persistenceSeconds)"
    );
    bytes32 private constant THETANUTS_QUOTE_TYPEHASH = keccak256(
        "ThetanutsQuote(bytes32 mandateHash,bytes32 fillCalldataHash,uint256 premium,uint256 contracts,uint64 observedAt,uint64 validUntil)"
    );
    bytes32 private constant SHADOW_CLOSE_TYPEHASH = keccak256(
        "ShadowClose(bytes32 mandateHash,bytes32 closeId,uint256 positionId,uint128 contractsE6,uint128 proceedsUsdc,uint64 observedAt,uint64 validUntil)"
    );
    bytes32 private constant MANDATE_NAME_HASH = keccak256("GammaShield Mandate");
    bytes32 private constant RISK_NAME_HASH = keccak256("GammaShield Risk");
    bytes32 private constant SHADOW_CLOSE_NAME_HASH = keccak256("GammaShield Shadow Close");
    bytes32 private constant VERSION_HASH = keccak256("1");

    address public immutable entryPoint;
    address public immutable owner;
    address public immutable riskAttester;
    mapping(bytes32 => MandateControl) public controls;
    mapping(bytes32 => Mandate) private mandates;
    mapping(bytes32 => bool) public isMandateRegistered;
    mapping(bytes32 => RiskState) public riskStates;
    bytes32 public activeMandateHash;

    event MandateRegistered(bytes32 indexed mandateHash, uint64 expiresAt);
    event MandatePaused(bytes32 indexed mandateHash);
    event MandateResumed(bytes32 indexed mandateHash);
    event MandateRevoked(bytes32 indexed mandateHash);
    event MandateExecuted(bytes32 indexed mandateHash, bytes32 indexed fillId, uint256 premiumUsdc, uint256 positionId);
    event RiskObserved(bytes32 indexed mandateHash, uint16 scoreBps, uint64 eligibleSince, uint64 validUntil);
    event MandateClosed(bytes32 indexed mandateHash, bytes32 indexed closeId, uint256 positionId, uint256 proceedsUsdc);
    event MandateRolled(bytes32 indexed mandateHash, uint256 closedPositionId, uint256 openedPositionId);

    modifier onlyEntryPoint() {
        require(msg.sender == entryPoint, "entry point only");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "owner only");
        _;
    }

    constructor(address entryPoint_, address owner_, address riskAttester_) {
        require(entryPoint_ != address(0) && owner_ != address(0) && riskAttester_ != address(0), "zero address");
        entryPoint = entryPoint_;
        owner = owner_;
        riskAttester = riskAttester_;
    }

    receive() external payable {}

    function mandateHash(Mandate memory mandate) public pure returns (bytes32 hash) {
        // The mandate has 18 static ABI fields. Encoding its fixed-width words
        // directly avoids a stack-too-deep compiler limitation without changing
        // the EIP-712 encoding.
        bytes32 typeHash = MANDATE_TYPEHASH;
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, typeHash)
            for { let offset := 0 } lt(offset, 576) { offset := add(offset, 32) } {
                mstore(add(ptr, add(32, offset)), mload(add(mandate, offset)))
            }
            mstore(0x40, add(ptr, 608))
            hash := keccak256(ptr, 608)
        }
    }

    function mandateDomainSeparator() public view returns (bytes32) {
        return _domainSeparator(MANDATE_NAME_HASH);
    }

    function riskDomainSeparator() public view returns (bytes32) {
        return _domainSeparator(RISK_NAME_HASH);
    }

    function shadowCloseDomainSeparator() public view returns (bytes32) {
        return _domainSeparator(SHADOW_CLOSE_NAME_HASH);
    }

    function thetanutsQuoteDomainSeparator() public view returns (bytes32) {
        return _domainSeparator(keccak256("GammaShield Thetanuts Quote"));
    }

    /// @notice ERC-4337 v0.7 validation. Owner signatures may use owner
    /// recovery; an agent signature is accepted only for a fully validated,
    /// registered executeShadow call.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        onlyEntryPoint
        returns (uint256 validationData)
    {
        bool valid;
        uint64 validUntil;
        if (userOp.sender == address(this) && userOp.callData.length >= 4) {
            bytes4 selector = bytes4(userOp.callData[:4]);
            if (selector == this.executeOwner.selector) {
                valid = _recover(userOpHash, userOp.signature) == owner;
            } else if (selector == this.recordRisk.selector) {
                (valid, validUntil) = _validateAgentRiskRecord(userOp.callData[4:], userOpHash, userOp.signature);
            } else if (selector == this.executeShadow.selector) {
                (valid, validUntil) = _validateAgentUserOp(userOp.callData[4:], userOpHash, userOp.signature);
            } else if (selector == this.executeThetanuts.selector) {
                (valid, validUntil) = _validateThetanutsUserOp(userOp.callData[4:], userOpHash, userOp.signature);
            } else if (selector == this.executeShadowClose.selector) {
                (valid, validUntil) = _validateShadowCloseUserOp(userOp.callData[4:], userOpHash, userOp.signature);
            } else if (selector == this.executeShadowRoll.selector) {
                (valid, validUntil) = _validateShadowRollUserOp(userOp.callData[4:], userOpHash, userOp.signature);
            }
        }

        if (!valid) return SIG_VALIDATION_FAILED;
        if (missingAccountFunds > 0) {
            (bool paid,) = payable(msg.sender).call{value: missingAccountFunds}("");
            paid;
        }
        return uint256(validUntil) << 160;
    }

    function _validateThetanutsUserOp(bytes calldata encodedCall, bytes32 userOpHash, bytes calldata agentSignature)
        private
        view
        returns (bool valid, uint64 validUntil)
    {
        (bytes32 mandateHash_, RiskAttestation memory risk, bytes memory riskSignature, ThetanutsQuote memory quote, bytes memory quoteSignature, bytes memory fillData) = abi.decode(
            encodedCall, (bytes32, RiskAttestation, bytes, ThetanutsQuote, bytes, bytes)
        );
        if (mandateHash_ == bytes32(0) || mandateHash_ != activeMandateHash) return (false, 0);
        Mandate memory mandate = mandates[mandateHash_];
        if (_recover(userOpHash, agentSignature) != mandate.agent) return (false, 0);
        MandateControl storage control = controls[mandateHash_];
        if (
            !_isPersistentRisk(riskStates[mandateHash_], mandate) || !_isRiskValid(mandateHash_, mandate, risk, riskSignature) ||
            !_isThetanutsQuoteValid(mandateHash_, mandate, quote, quoteSignature, fillData) || control.paused || control.revoked ||
            control.spentPremium + quote.premium > mandate.maxPremiumTotal ||
            (control.lastExecutionAt != 0 && block.timestamp < uint256(control.lastExecutionAt) + mandate.minExecutionIntervalSeconds)
        ) return (false, 0);
        return (true, _minimum(mandate.expiresAt, _minimum(risk.validUntil, quote.validUntil)));
    }

    function _validateAgentUserOp(bytes calldata encodedCall, bytes32 userOpHash, bytes calldata agentSignature)
        private
        view
        returns (bool valid, uint64 validUntil)
    {
        (bytes32 mandateHash_, RiskAttestation memory risk, bytes memory riskSignature, IShadowFill.ShadowQuote memory quote,) = abi.decode(
            encodedCall, (bytes32, RiskAttestation, bytes, IShadowFill.ShadowQuote, bytes)
        );
        return _validAgentExecution(mandateHash_, risk, riskSignature, quote, userOpHash, agentSignature);
    }

    function _validateShadowCloseUserOp(bytes calldata encodedCall, bytes32 userOpHash, bytes calldata agentSignature)
        private
        view
        returns (bool valid, uint64 validUntil)
    {
        (bytes32 mandateHash_, ShadowCloseAttestation memory attestation, bytes memory attestationSignature, IShadowFill.ShadowClose memory close,) =
            abi.decode(encodedCall, (bytes32, ShadowCloseAttestation, bytes, IShadowFill.ShadowClose, bytes));
        if (mandateHash_ == bytes32(0) || mandateHash_ != activeMandateHash) return (false, 0);
        Mandate memory mandate = mandates[mandateHash_];
        MandateControl storage control = controls[mandateHash_];
        if (
            _recover(userOpHash, agentSignature) != mandate.agent || control.paused || control.revoked ||
            !_isShadowCloseValid(mandateHash_, attestation, attestationSignature, close)
        ) return (false, 0);
        // Closing is a de-risking exit, so it is deliberately not gated on hot
        // risk evidence or the spend cooldown; both of those rate-limit buying.
        return (true, _minimum(mandate.expiresAt, _minimum(attestation.validUntil, close.validUntil)));
    }

    function _validateShadowRollUserOp(bytes calldata encodedCall, bytes32 userOpHash, bytes calldata agentSignature)
        private
        view
        returns (bool valid, uint64 validUntil)
    {
        (bytes32 mandateHash_, RollRequest memory request) = abi.decode(encodedCall, (bytes32, RollRequest));
        if (mandateHash_ == bytes32(0) || mandateHash_ != activeMandateHash) return (false, 0);
        Mandate memory mandate = mandates[mandateHash_];
        if (_recover(userOpHash, agentSignature) != mandate.agent || !_isRollValid(mandateHash_, mandate, request)) return (false, 0);
        return (
            true,
            _minimum(
                mandate.expiresAt,
                _minimum(request.risk.validUntil, _minimum(request.close.validUntil, request.quote.validUntil))
            )
        );
    }

    function _validateAgentRiskRecord(bytes calldata encodedCall, bytes32 userOpHash, bytes calldata agentSignature)
        private
        view
        returns (bool valid, uint64 validUntil)
    {
        (bytes32 mandateHash_, RiskAttestation memory risk, bytes memory riskSignature) = abi.decode(encodedCall, (bytes32, RiskAttestation, bytes));
        if (mandateHash_ == bytes32(0) || mandateHash_ != activeMandateHash) return (false, 0);
        Mandate memory mandate = mandates[mandateHash_];
        if (_recover(userOpHash, agentSignature) != mandate.agent || !_isRiskObservationValid(mandateHash_, mandate, risk, riskSignature)) return (false, 0);
        return (true, risk.validUntil);
    }

    function executeOwner(address to, uint256 value, bytes calldata data) external onlyEntryPoint {
        require(to != address(0), "zero target");
        (bool success, bytes memory result) = to.call{value: value}(data);
        if (!success) _revert(result);
    }

    function registerMandate(Mandate calldata mandate, bytes calldata signature) external onlyOwner returns (bytes32 hash) {
        hash = _requireMandate(mandate, signature);
        require(!isMandateRegistered[hash], "mandate registered");
        if (activeMandateHash != bytes32(0)) {
            controls[activeMandateHash].revoked = true;
            emit MandateRevoked(activeMandateHash);
        }
        mandates[hash] = mandate;
        isMandateRegistered[hash] = true;
        activeMandateHash = hash;
        emit MandateRegistered(hash, mandate.expiresAt);
    }

    function getMandate(bytes32 hash) external view returns (Mandate memory) {
        require(isMandateRegistered[hash], "mandate unavailable");
        return mandates[hash];
    }

    function pauseMandate(bytes32 hash) external onlyOwner {
        require(hash == activeMandateHash, "mandate inactive");
        require(!controls[hash].revoked, "mandate revoked");
        controls[hash].paused = true;
        emit MandatePaused(hash);
    }

    function resumeMandate(bytes32 hash) external onlyOwner {
        require(hash == activeMandateHash, "mandate inactive");
        MandateControl storage control = controls[hash];
        require(!control.revoked && block.timestamp < mandates[hash].expiresAt, "mandate inactive");
        control.paused = false;
        emit MandateResumed(hash);
    }

    function revokeMandate(bytes32 hash) external onlyOwner {
        require(hash == activeMandateHash, "mandate inactive");
        controls[hash].revoked = true;
        activeMandateHash = bytes32(0);
        emit MandateRevoked(hash);
    }

    /// @notice Records a short-lived risk observation. A separate agent
    /// UserOperation is required before the account can use that risk state.
    function recordRisk(bytes32 hash, RiskAttestation calldata risk, bytes calldata signature) external onlyEntryPoint {
        Mandate memory mandate = _requireActiveMandate(hash);
        _requireRiskObservation(hash, mandate, risk, signature);

        RiskState storage state = riskStates[hash];
        bool eligible = risk.riskScoreBps >= mandate.riskThresholdBps;
        bool continuous = eligible && state.eligibleSince != 0 && state.scoreBps >= mandate.riskThresholdBps &&
            state.validUntil >= block.timestamp && risk.observedAt >= state.observedAt;
        state.eligibleSince = continuous ? state.eligibleSince : (eligible ? uint64(block.timestamp) : 0);
        state.scoreBps = risk.riskScoreBps;
        state.observedAt = risk.observedAt;
        state.validUntil = risk.validUntil;
        emit RiskObserved(hash, risk.riskScoreBps, state.eligibleSince, risk.validUntil);
    }

    function executeShadow(
        bytes32 hash,
        RiskAttestation calldata risk,
        bytes calldata riskSignature,
        IShadowFill.ShadowQuote calldata quote,
        bytes calldata quoteSignature
    ) external onlyEntryPoint returns (uint256 positionId) {
        Mandate memory mandate = _requireActiveMandate(hash);
        _requirePersistentRisk(hash, mandate);
        _requireRisk(hash, mandate, risk, riskSignature);
        _requireQuote(mandate, quote);

        MandateControl storage control = controls[hash];
        require(!control.paused && !control.revoked, "mandate inactive");
        require(control.spentPremium + quote.premiumUsdc <= mandate.maxPremiumTotal, "total cap exceeded");
        require(
            control.lastExecutionAt == 0 || block.timestamp >= uint256(control.lastExecutionAt) + mandate.minExecutionIntervalSeconds,
            "execution cooldown"
        );

        // Exact, per-fill allowance. A failed fill reverts this approval too.
        _call(mandate.collateral, abi.encodeCall(IERC20Approval.approve, (mandate.optionBook, quote.premiumUsdc)), true);
        bytes memory result = _call(mandate.optionBook, abi.encodeCall(IShadowFill.fillShadow, (quote, quoteSignature)), false);
        positionId = abi.decode(result, (uint256));

        control.spentPremium += quote.premiumUsdc;
        control.lastExecutionAt = uint64(block.timestamp);
        emit MandateExecuted(hash, quote.fillId, quote.premiumUsdc, positionId);
    }

    /// @notice Mainnet-only adapter for a freshly SDK-previewed, listed Thetanuts PUT.
    /// The account reconstructs no contract calldata itself: it validates the exact SDK
    /// fill payload, grants the exact premium allowance, then calls Base OptionBook.
    function executeThetanuts(
        bytes32 hash,
        RiskAttestation calldata risk,
        bytes calldata riskSignature,
        ThetanutsQuote calldata quote,
        bytes calldata quoteSignature,
        bytes calldata fillData
    ) external onlyEntryPoint returns (address optionAddress) {
        Mandate memory mandate = _requireActiveMandate(hash);
        _requirePersistentRisk(hash, mandate);
        _requireRisk(hash, mandate, risk, riskSignature);
        _requireThetanutsQuote(hash, mandate, quote, quoteSignature, fillData);

        MandateControl storage control = controls[hash];
        require(!control.paused && !control.revoked, "mandate inactive");
        require(control.spentPremium + quote.premium <= mandate.maxPremiumTotal, "total cap exceeded");
        require(
            control.lastExecutionAt == 0 || block.timestamp >= uint256(control.lastExecutionAt) + mandate.minExecutionIntervalSeconds,
            "execution cooldown"
        );

        _call(mandate.collateral, abi.encodeCall(IERC20Approval.approve, (mandate.optionBook, quote.premium)), true);
        bytes memory result = _call(mandate.optionBook, fillData, false);
        optionAddress = abi.decode(result, (address));

        control.spentPremium += quote.premium;
        control.lastExecutionAt = uint64(block.timestamp);
        emit MandateExecuted(hash, quote.fillCalldataHash, quote.premium, uint256(uint160(optionAddress)));
    }

    /// @notice Sepolia-only exit. Closes one shadow position at an agent-attested
    /// mark and credits the recovered premium back to this policy's loss meter.
    function executeShadowClose(
        bytes32 hash,
        ShadowCloseAttestation calldata attestation,
        bytes calldata attestationSignature,
        IShadowFill.ShadowClose calldata close,
        bytes calldata closeSignature
    ) external onlyEntryPoint returns (uint128 proceedsUsdc) {
        Mandate memory mandate = _requireActiveMandate(hash);
        require(_isShadowCloseValid(hash, attestation, attestationSignature, close), "invalid close");

        MandateControl storage control = controls[hash];
        require(!control.paused && !control.revoked, "mandate inactive");

        proceedsUsdc = abi.decode(
            _call(mandate.optionBook, abi.encodeCall(IShadowFill.closeShadow, (close, closeSignature)), false), (uint128)
        );
        _creditClose(control, proceedsUsdc);
        emit MandateClosed(hash, close.closeId, close.positionId, proceedsUsdc);
    }

    /// @notice Sepolia-only roll: close the near-dated leg and open the next one
    /// in a single call, so the account is never briefly unhedged. Unlike a bare
    /// close this requires hot, persistent risk evidence — a roll opens new
    /// exposure, and an expiring hedge that is no longer needed should simply
    /// be closed or left to expire.
    function executeShadowRoll(bytes32 hash, RollRequest calldata request)
        external
        onlyEntryPoint
        returns (uint256 positionId)
    {
        Mandate memory mandate = _requireActiveMandate(hash);
        require(_isRollValid(hash, mandate, request), "invalid roll");

        MandateControl storage control = controls[hash];
        uint128 proceeds = abi.decode(
            _call(
                mandate.optionBook,
                abi.encodeCall(IShadowFill.closeShadow, (request.close, request.closeSignature)),
                false
            ),
            (uint128)
        );
        _creditClose(control, proceeds);
        emit MandateClosed(hash, request.close.closeId, request.close.positionId, proceeds);

        _call(
            mandate.collateral,
            abi.encodeCall(IERC20Approval.approve, (mandate.optionBook, request.quote.premiumUsdc)),
            true
        );
        positionId = abi.decode(
            _call(
                mandate.optionBook,
                abi.encodeCall(IShadowFill.fillShadow, (request.quote, request.quoteSignature)),
                false
            ),
            (uint256)
        );

        control.spentPremium += request.quote.premiumUsdc;
        control.lastExecutionAt = uint64(block.timestamp);
        emit MandateExecuted(hash, request.quote.fillId, request.quote.premiumUsdc, positionId);
        emit MandateRolled(hash, request.close.positionId, positionId);
    }

    /// @dev Every condition a roll must satisfy, shared by 4337 validation and
    /// execution so the simulated call and the real one can never disagree.
    function _isRollValid(bytes32 hash, Mandate memory mandate, RollRequest memory request) private view returns (bool) {
        MandateControl storage control = controls[hash];
        return !control.paused && !control.revoked &&
            _isPersistentRisk(riskStates[hash], mandate) &&
            _isRiskValid(hash, mandate, request.risk, request.riskSignature) &&
            _isShadowCloseValid(hash, request.attestation, request.attestationSignature, request.close) &&
            _isQuoteValid(mandate, request.quote) &&
            _isRollWithinCaps(control, request.attestation, request.quote, mandate);
    }

    /// @dev `spentPremium` is the loss meter the signed cap is measured against:
    /// premium paid, less premium recovered. Crediting is capped at what this
    /// policy actually spent, so an exit can restore budget but never create it.
    function _creditClose(MandateControl storage control, uint128 proceeds) private {
        uint256 credit = uint256(proceeds) > control.spentPremium ? control.spentPremium : uint256(proceeds);
        control.spentPremium -= credit;
    }

    function _validAgentExecution(
        bytes32 hash,
        RiskAttestation memory risk,
        bytes memory riskSignature,
        IShadowFill.ShadowQuote memory quote,
        bytes32 userOpHash,
        bytes calldata agentSignature
    ) private view returns (bool valid, uint64 validUntil) {
        if (hash == bytes32(0) || hash != activeMandateHash) return (false, 0);
        Mandate memory mandate = mandates[hash];
        if (_recover(userOpHash, agentSignature) != mandate.agent) return (false, 0);
        RiskState memory persistedRisk = riskStates[hash];
        if (!_isPersistentRisk(persistedRisk, mandate) || !_isRiskValid(hash, mandate, risk, riskSignature) || !_isQuoteValid(mandate, quote)) {
            return (false, 0);
        }
        MandateControl storage control = controls[hash];
        if (
            control.paused || control.revoked || control.spentPremium + quote.premiumUsdc > mandate.maxPremiumTotal ||
            (control.lastExecutionAt != 0 && block.timestamp < uint256(control.lastExecutionAt) + mandate.minExecutionIntervalSeconds)
        ) return (false, 0);
        validUntil = _minimum(mandate.expiresAt, _minimum(risk.validUntil, quote.validUntil));
        return (true, validUntil);
    }

    function _requireMandate(Mandate calldata mandate, bytes calldata signature) private view returns (bytes32 hash) {
        require(_isMandateValid(mandate, signature), "invalid mandate");
        return mandateHash(mandate);
    }

    function _requireActiveMandate(bytes32 hash) private view returns (Mandate memory mandate) {
        require(hash != bytes32(0) && hash == activeMandateHash, "mandate inactive");
        return mandates[hash];
    }

    function _requirePersistentRisk(bytes32 hash, Mandate memory mandate) private view {
        require(_isPersistentRisk(riskStates[hash], mandate), "risk not persistent");
    }

    function _requireRisk(bytes32 mandateHash_, Mandate memory mandate, RiskAttestation calldata risk, bytes calldata signature) private view {
        require(_isRiskValid(mandateHash_, mandate, risk, signature), "invalid risk attestation");
    }

    function _requireRiskObservation(bytes32 mandateHash_, Mandate memory mandate, RiskAttestation calldata risk, bytes calldata signature) private view {
        require(_isRiskObservationValid(mandateHash_, mandate, risk, signature), "invalid risk observation");
    }

    function _requireQuote(Mandate memory mandate, IShadowFill.ShadowQuote calldata quote) private view {
        require(_isQuoteValid(mandate, quote), "quote violates mandate");
    }

    function _requireThetanutsQuote(
        bytes32 mandateHash_, Mandate memory mandate, ThetanutsQuote calldata quote, bytes calldata signature, bytes calldata fillData
    ) private view {
        require(_isThetanutsQuoteValid(mandateHash_, mandate, quote, signature, fillData), "Thetanuts quote violates mandate");
    }

    function _isMandateValid(Mandate memory mandate, bytes memory signature) private view returns (bool) {
        if (
            mandate.owner != owner || mandate.account != address(this) || mandate.agent == address(0) || mandate.agent == owner ||
            mandate.optionBook == address(0) || mandate.collateral == address(0) || mandate.side > 1 ||
            mandate.maxPremiumPerFill == 0 || mandate.maxPremiumTotal < mandate.maxPremiumPerFill || mandate.maxContractsPerFill == 0 ||
            mandate.minTenorSeconds == 0 || mandate.maxTenorSeconds < mandate.minTenorSeconds || mandate.riskThresholdBps > 10_000 ||
            mandate.expiresAt <= mandate.validAfter || mandate.persistenceSeconds > mandate.expiresAt - mandate.validAfter ||
            block.timestamp < mandate.validAfter || block.timestamp >= mandate.expiresAt
        ) return false;
        return _recover(_typedDataHash(_domainSeparator(MANDATE_NAME_HASH), mandateHash(mandate)), signature) == owner;
    }

    function _isRiskValid(bytes32 mandateHash_, Mandate memory mandate, RiskAttestation memory risk, bytes memory signature) private view returns (bool) {
        if (
            risk.riskScoreBps < mandate.riskThresholdBps ||
            !_isRiskObservationValid(mandateHash_, mandate, risk, signature)
        ) return false;
        return true;
    }

    function _isRiskObservationValid(bytes32 mandateHash_, Mandate memory mandate, RiskAttestation memory risk, bytes memory signature) private view returns (bool) {
        if (
            risk.mandateHash != mandateHash_ || risk.riskScoreBps > 10_000 || risk.observedAt > block.timestamp ||
            block.timestamp - risk.observedAt > MAX_RISK_OBSERVATION_AGE || risk.validUntil < risk.observedAt ||
            risk.validUntil - risk.observedAt > MAX_RISK_OBSERVATION_AGE || risk.validUntil < block.timestamp ||
            risk.persistenceSeconds < mandate.persistenceSeconds
        ) return false;
        bytes32 riskHash = keccak256(abi.encode(RISK_TYPEHASH, risk.mandateHash, risk.riskScoreBps, risk.observedAt, risk.validUntil, risk.persistenceSeconds));
        return _recover(_typedDataHash(_domainSeparator(RISK_NAME_HASH), riskHash), signature) == riskAttester;
    }

    function _isShadowCloseValid(
        bytes32 mandateHash_,
        ShadowCloseAttestation memory attestation,
        bytes memory signature,
        IShadowFill.ShadowClose memory close
    ) private view returns (bool) {
        if (
            attestation.mandateHash != mandateHash_ || attestation.closeId != close.closeId ||
            attestation.positionId != close.positionId || attestation.contractsE6 != close.contractsE6 ||
            attestation.proceedsUsdc != close.proceedsUsdc || close.seller != address(this) ||
            close.contractsE6 == 0 || attestation.validUntil < block.timestamp || close.validUntil < block.timestamp ||
            attestation.observedAt > block.timestamp ||
            block.timestamp - attestation.observedAt > MAX_THETANUTS_QUOTE_AGE
        ) return false;
        bytes32 structHash = keccak256(
            abi.encode(
                SHADOW_CLOSE_TYPEHASH,
                attestation.mandateHash,
                attestation.closeId,
                attestation.positionId,
                attestation.contractsE6,
                attestation.proceedsUsdc,
                attestation.observedAt,
                attestation.validUntil
            )
        );
        return _recover(_typedDataHash(_domainSeparator(SHADOW_CLOSE_NAME_HASH), structHash), signature) == riskAttester;
    }

    /// @dev A roll must fit the signed total cap measured after the exit credit,
    /// and still respect the spend cooldown that rate-limits opening exposure.
    function _isRollWithinCaps(
        MandateControl storage control,
        ShadowCloseAttestation memory attestation,
        IShadowFill.ShadowQuote memory quote,
        Mandate memory mandate
    ) private view returns (bool) {
        uint256 credit = uint256(attestation.proceedsUsdc) > control.spentPremium ? control.spentPremium : uint256(attestation.proceedsUsdc);
        if (control.spentPremium - credit + quote.premiumUsdc > mandate.maxPremiumTotal) return false;
        return control.lastExecutionAt == 0 || block.timestamp >= uint256(control.lastExecutionAt) + mandate.minExecutionIntervalSeconds;
    }

    function _isPersistentRisk(RiskState memory risk, Mandate memory mandate) private view returns (bool) {
        return risk.eligibleSince != 0 && risk.scoreBps >= mandate.riskThresholdBps && risk.validUntil >= block.timestamp &&
            block.timestamp >= uint256(risk.eligibleSince) + mandate.persistenceSeconds;
    }

    function _isQuoteValid(Mandate memory mandate, IShadowFill.ShadowQuote memory quote) private view returns (bool) {
        if (
            quote.buyer != address(this) || quote.asset != mandate.asset || quote.isCall != (mandate.side == 0) ||
            quote.expiry <= block.timestamp || quote.validUntil < block.timestamp || quote.contractsE6 == 0 || quote.premiumUsdc == 0 ||
            quote.premiumUsdc > mandate.maxPremiumPerFill || quote.contractsE6 > mandate.maxContractsPerFill
        ) return false;
        uint256 tenor = uint256(quote.expiry) - block.timestamp;
        return tenor >= mandate.minTenorSeconds && tenor <= mandate.maxTenorSeconds;
    }

    function _isThetanutsQuoteValid(
        bytes32 mandateHash_, Mandate memory mandate, ThetanutsQuote memory quote, bytes memory signature, bytes memory fillData
    ) private view returns (bool) {
        if (
            block.chainid != 8453 || mandate.optionBook != BASE_OPTION_BOOK || mandate.collateral != BASE_USDC || mandate.side != 1 ||
            quote.mandateHash != mandateHash_ || quote.fillCalldataHash != keccak256(fillData) || quote.observedAt > block.timestamp ||
            block.timestamp - quote.observedAt > MAX_THETANUTS_QUOTE_AGE || quote.validUntil < block.timestamp ||
            quote.validUntil < quote.observedAt || quote.validUntil - quote.observedAt > MAX_THETANUTS_QUOTE_AGE
        ) return false;
        bytes32 quoteHash = keccak256(abi.encode(
            THETANUTS_QUOTE_TYPEHASH, quote.mandateHash, quote.fillCalldataHash, quote.premium, quote.contracts, quote.observedAt, quote.validUntil
        ));
        if (_recover(_typedDataHash(_domainSeparator(keccak256("GammaShield Thetanuts Quote")), quoteHash), signature) != riskAttester) return false;
        if (fillData.length < 4 || _selector(fillData) != IThetanutsOptionBook.fillOrder.selector) return false;
        bytes memory parameters = new bytes(fillData.length - 4);
        assembly {
            let source := add(fillData, 36)
            let destination := add(parameters, 32)
            let end := add(destination, mload(parameters))
            for {} lt(destination, end) { destination := add(destination, 32) source := add(source, 32) } {
                mstore(destination, mload(source))
            }
        }
        (IThetanutsOptionBook.Order memory order, bytes memory makerSignature, address referrer) = abi.decode(
            parameters, (IThetanutsOptionBook.Order, bytes, address)
        );
        if (
            makerSignature.length != 65 || referrer != address(0) || order.maker == address(0) || order.isCall || order.isLong ||
            order.collateral != BASE_USDC || order.implementation != BASE_PUT_IMPLEMENTATION || order.strikes.length != 1 ||
            order.extraOptionData.length != 0 || order.price == 0 || order.numContracts == 0 || order.numContracts > mandate.maxContractsPerFill ||
            order.price > type(uint256).max / order.numContracts || order.orderExpiryTimestamp <= block.timestamp ||
            order.expiry <= block.timestamp || quote.contracts != order.numContracts
        ) return false;
        address expectedFeed = mandate.asset == bytes32("ETH") ? BASE_ETH_FEED : mandate.asset == bytes32("BTC") ? BASE_BTC_FEED : address(0);
        if (expectedFeed == address(0) || order.priceFeed != expectedFeed) return false;
        uint256 tenor = order.expiry - block.timestamp;
        uint256 premium = order.price * order.numContracts / 1e8;
        return tenor >= mandate.minTenorSeconds && tenor <= mandate.maxTenorSeconds && premium > 0 && premium == quote.premium && premium <= mandate.maxPremiumPerFill;
    }

    function _selector(bytes memory data) private pure returns (bytes4 selector) {
        assembly {
            selector := mload(add(data, 32))
        }
    }

    function _domainSeparator(bytes32 nameHash) private view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, nameHash, VERSION_HASH, block.chainid, address(this)));
    }

    function _typedDataHash(bytes32 domain, bytes32 structHash) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _recover(bytes32 digest, bytes memory signature) private pure returns (address signer) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (uint256(s) > SECP256K1N_HALF || (v != 27 && v != 28)) return address(0);
        signer = ecrecover(digest, v, r, s);
    }

    function _call(address target, bytes memory data, bool requiresTrue) private returns (bytes memory result) {
        (bool success, bytes memory returnData) = target.call(data);
        if (!success) _revert(returnData);
        if (requiresTrue && returnData.length > 0) require(abi.decode(returnData, (bool)), "token call failed");
        return returnData;
    }

    function _revert(bytes memory data) private pure {
        if (data.length == 0) revert("external call failed");
        assembly {
            revert(add(data, 0x20), mload(data))
        }
    }

    function _minimum(uint64 a, uint64 b) private pure returns (uint64) {
        return a < b ? a : b;
    }
}

contract MandateAccountFactory {
    address public immutable entryPoint;
    address public immutable riskAttester;

    event AccountCreated(address indexed account, address indexed owner, bytes32 indexed salt);

    constructor(address entryPoint_, address riskAttester_) {
        require(entryPoint_ != address(0) && riskAttester_ != address(0), "zero address");
        entryPoint = entryPoint_;
        riskAttester = riskAttester_;
    }

    function createAccount(address owner, bytes32 salt) external returns (MandateAccount account) {
        require(owner != address(0), "zero owner");
        account = new MandateAccount{salt: salt}(entryPoint, owner, riskAttester);
        emit AccountCreated(address(account), owner, salt);
    }

    function getAddress(address owner, bytes32 salt) external view returns (address) {
        bytes32 bytecodeHash = keccak256(abi.encodePacked(type(MandateAccount).creationCode, abi.encode(entryPoint, owner, riskAttester)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, bytecodeHash)))));
    }
}
