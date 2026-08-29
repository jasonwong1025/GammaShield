// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
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
    bytes32 private constant NAME_HASH = keccak256("GammaShield Shadow OptionBook");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    IERC20 public immutable collateral;
    address public immutable attester;
    uint256 public nextPositionId;
    mapping(bytes32 => bool) public usedFillIds;
    mapping(uint256 => Position) public positions;

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
