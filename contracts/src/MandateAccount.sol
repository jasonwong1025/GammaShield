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

    function fillShadow(ShadowQuote calldata quote, bytes calldata signature) external returns (uint256 positionId);
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
    bytes32 private constant MANDATE_NAME_HASH = keccak256("GammaShield Mandate");
    bytes32 private constant RISK_NAME_HASH = keccak256("GammaShield Risk");
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
            }
        }

        if (!valid) return SIG_VALIDATION_FAILED;
        if (missingAccountFunds > 0) {
            (bool paid,) = payable(msg.sender).call{value: missingAccountFunds}("");
            paid;
        }
        return uint256(validUntil) << 160;
    }

    function _validateAgentUserOp(bytes calldata encodedCall, bytes32 userOpHash, bytes calldata agentSignature)
        private
        view
        returns (bool valid, uint64 validUntil)
    {
        (bytes32 mandateHash_, IShadowFill.ShadowQuote memory quote,) = abi.decode(
            encodedCall, (bytes32, IShadowFill.ShadowQuote, bytes)
        );
        return _validAgentExecution(mandateHash_, quote, userOpHash, agentSignature);
    }

    function _validateAgentRiskRecord(bytes calldata encodedCall, bytes32 userOpHash, bytes calldata agentSignature)
        private
        view
        returns (bool valid, uint64 validUntil)
    {
        (bytes32 mandateHash_, RiskAttestation memory risk, bytes memory riskSignature) = abi.decode(encodedCall, (bytes32, RiskAttestation, bytes));
        if (mandateHash_ == bytes32(0) || mandateHash_ != activeMandateHash) return (false, 0);
        Mandate memory mandate = mandates[mandateHash_];
        if (_recover(userOpHash, agentSignature) != mandate.agent || !_isRiskValid(mandateHash_, mandate, risk, riskSignature)) return (false, 0);
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
        _requireRisk(hash, mandate, risk, signature);

        RiskState storage state = riskStates[hash];
        bool continuous = state.eligibleSince != 0 && state.validUntil >= block.timestamp && risk.observedAt >= state.observedAt;
        state.eligibleSince = continuous ? state.eligibleSince : uint64(block.timestamp);
        state.scoreBps = risk.riskScoreBps;
        state.observedAt = risk.observedAt;
        state.validUntil = risk.validUntil;
        emit RiskObserved(hash, risk.riskScoreBps, state.eligibleSince, risk.validUntil);
    }

    function executeShadow(
        bytes32 hash,
        IShadowFill.ShadowQuote calldata quote,
        bytes calldata quoteSignature
    ) external onlyEntryPoint returns (uint256 positionId) {
        Mandate memory mandate = _requireActiveMandate(hash);
        _requirePersistentRisk(hash, mandate);
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

    function _validAgentExecution(
        bytes32 hash,
        IShadowFill.ShadowQuote memory quote,
        bytes32 userOpHash,
        bytes calldata agentSignature
    ) private view returns (bool valid, uint64 validUntil) {
        if (hash == bytes32(0) || hash != activeMandateHash) return (false, 0);
        Mandate memory mandate = mandates[hash];
        if (_recover(userOpHash, agentSignature) != mandate.agent) return (false, 0);
        RiskState memory risk = riskStates[hash];
        if (!_isPersistentRisk(risk, mandate) || !_isQuoteValid(mandate, quote)) {
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

    function _requireQuote(Mandate memory mandate, IShadowFill.ShadowQuote calldata quote) private view {
        require(_isQuoteValid(mandate, quote), "quote violates mandate");
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
            risk.mandateHash != mandateHash_ || risk.riskScoreBps < mandate.riskThresholdBps || risk.observedAt > block.timestamp ||
            block.timestamp - risk.observedAt > MAX_RISK_OBSERVATION_AGE || risk.validUntil < risk.observedAt ||
            risk.validUntil - risk.observedAt > MAX_RISK_OBSERVATION_AGE || risk.validUntil < block.timestamp ||
            risk.persistenceSeconds < mandate.persistenceSeconds
        ) return false;
        bytes32 riskHash = keccak256(abi.encode(RISK_TYPEHASH, risk.mandateHash, risk.riskScoreBps, risk.observedAt, risk.validUntil, risk.persistenceSeconds));
        return _recover(_typedDataHash(_domainSeparator(RISK_NAME_HASH), riskHash), signature) == riskAttester;
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
