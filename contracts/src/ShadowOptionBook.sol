// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Base Sepolia-only receipt book. It mirrors signed GammaShield snapshots,
/// not Thetanuts liquidity, positions, or settlement.
contract ShadowOptionBook {
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

    /// @notice An attested exit mark for one open shadow position. `proceedsUsdc`
    /// is what the attester says the position is worth now; this book holds no
    /// market and cannot discover that price itself.
    struct ShadowClose {
        bytes32 closeId;
        uint256 positionId;
        address seller;
        uint64 validUntil;
        uint128 contractsE6;
        uint128 proceedsUsdc;
    }

    struct Position {
        bytes32 sourceHash;
        bytes32 asset;
        address buyer;
        bool isCall;
        uint128 strikeE8;
        uint64 expiry;
        uint128 contractsE6;
        uint128 premiumUsdc;
    }

    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "ShadowQuote(bytes32 fillId,bytes32 sourceHash,bytes32 asset,address buyer,bool isCall,uint128 strikeE8,uint64 expiry,uint64 validUntil,uint128 contractsE6,uint128 premiumUsdc)"
    );
    bytes32 private constant CLOSE_TYPEHASH = keccak256(
        "ShadowClose(bytes32 closeId,uint256 positionId,address seller,uint64 validUntil,uint128 contractsE6,uint128 proceedsUsdc)"
    );
    bytes32 private constant NAME_HASH = keccak256("GammaShield Shadow OptionBook");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    IERC20 public immutable collateral;
    address public immutable attester;
    uint256 public nextPositionId;
    mapping(bytes32 => bool) public usedFillIds;
    mapping(bytes32 => bool) public usedCloseIds;
    mapping(uint256 => Position) public positions;
    /// @notice Unix time a position was closed, or 0 while it is still open.
    mapping(uint256 => uint64) public closedAt;

    event ShadowOrderFilled(
        uint256 indexed positionId,
        bytes32 indexed fillId,
        bytes32 indexed sourceHash,
        address buyer,
        bytes32 asset,
        bool isCall,
        uint128 strikeE8,
        uint64 expiry,
        uint128 contractsE6,
        uint128 premiumUsdc
    );

    event ShadowPositionClosed(
        uint256 indexed positionId,
        bytes32 indexed closeId,
        address seller,
        uint128 contractsE6,
        uint128 proceedsUsdc
    );

    constructor(address collateral_, address attester_) {
        require(collateral_ != address(0) && attester_ != address(0), "zero address");
        collateral = IERC20(collateral_);
        attester = attester_;
    }

    function fillShadow(ShadowQuote calldata quote, bytes calldata signature) external returns (uint256 positionId) {
        require(quote.buyer == msg.sender, "wrong buyer");
        require(quote.expiry > block.timestamp, "option expired");
        require(quote.validUntil >= block.timestamp, "quote expired");
        require(quote.contractsE6 > 0 && quote.premiumUsdc > 0, "empty quote");
        require(!usedFillIds[quote.fillId], "quote used");
        require(_recover(_digest(quote), signature) == attester, "invalid attestation");

        usedFillIds[quote.fillId] = true;
        require(collateral.transferFrom(msg.sender, address(this), quote.premiumUsdc), "payment failed");

        positionId = nextPositionId++;
        positions[positionId] = Position({
            sourceHash: quote.sourceHash,
            asset: quote.asset,
            buyer: quote.buyer,
            isCall: quote.isCall,
            strikeE8: quote.strikeE8,
            expiry: quote.expiry,
            contractsE6: quote.contractsE6,
            premiumUsdc: quote.premiumUsdc
        });
        emit ShadowOrderFilled(
            positionId,
            quote.fillId,
            quote.sourceHash,
            quote.buyer,
            quote.asset,
            quote.isCall,
            quote.strikeE8,
            quote.expiry,
            quote.contractsE6,
            quote.premiumUsdc
        );
    }

    /// @notice Close one open shadow position at an attested mark and pay the
    /// seller out of this book's own collateral balance.
    ///
    /// Full closes only. A partial exit would split one receipt's premium
    /// across two lots, and the loss accounting in MandateAccount treats
    /// `spentPremium` as a single net number per position.
    function closeShadow(ShadowClose calldata close, bytes calldata signature) external returns (uint128 proceedsUsdc) {
        Position memory position = positions[close.positionId];
        require(position.buyer != address(0), "unknown position");
        require(position.buyer == msg.sender && close.seller == msg.sender, "wrong seller");
        require(closedAt[close.positionId] == 0, "already closed");
        require(close.validUntil >= block.timestamp, "close expired");
        require(close.contractsE6 == position.contractsE6, "partial close");
        require(!usedCloseIds[close.closeId], "close used");
        require(_recover(_closeDigest(close), signature) == attester, "invalid attestation");
        require(collateral.balanceOf(address(this)) >= close.proceedsUsdc, "book underfunded");

        usedCloseIds[close.closeId] = true;
        closedAt[close.positionId] = uint64(block.timestamp);
        proceedsUsdc = close.proceedsUsdc;

        // A worthless option closes for nothing; that is a real outcome, not an error.
        if (proceedsUsdc > 0) {
            require(collateral.transfer(msg.sender, proceedsUsdc), "payout failed");
        }
        emit ShadowPositionClosed(close.positionId, close.closeId, msg.sender, close.contractsE6, proceedsUsdc);
    }

    /// @notice 1 = fill only. 2 = fill and close. An older deployment has no
    /// such function at all, so a failed call means "fill only".
    function version() external pure returns (uint16) {
        return 2;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function _digest(ShadowQuote calldata quote) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                quote.fillId,
                quote.sourceHash,
                quote.asset,
                quote.buyer,
                quote.isCall,
                quote.strikeE8,
                quote.expiry,
                quote.validUntil,
                quote.contractsE6,
                quote.premiumUsdc
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _closeDigest(ShadowClose calldata close) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CLOSE_TYPEHASH,
                close.closeId,
                close.positionId,
                close.seller,
                close.validUntil,
                close.contractsE6,
                close.proceedsUsdc
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        require(signature.length == 65, "invalid signature");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        require(uint256(s) <= SECP256K1N_HALF && (v == 27 || v == 28), "invalid signature");
        signer = ecrecover(digest, v, r, s);
    }
}
