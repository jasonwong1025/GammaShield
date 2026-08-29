// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockUSDC} from "./MockUSDC.sol";
import {ShadowOptionBook} from "../src/ShadowOptionBook.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function prank(address) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
}

contract ShadowOptionBookTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant ATTESTER_KEY = 0xA11CE;
    address private constant BUYER = address(0xB0B);

    MockUSDC private token;
    ShadowOptionBook private book;

    function setUp() public {
        token = new MockUSDC();
        address attester = vm.addr(ATTESTER_KEY);
        book = new ShadowOptionBook(address(token), attester);
        token.mint(BUYER, 100e6);
        vm.prank(BUYER);
        token.approve(address(book), type(uint256).max);
    }

    function testSignedQuoteCreatesOnePaidPosition() public {
        ShadowOptionBook.ShadowQuote memory quote = _quote();
        bytes memory signature = _sign(quote);

        vm.prank(BUYER);
        uint256 positionId = book.fillShadow(quote, signature);

        require(positionId == 0, "unexpected position");
        require(token.balanceOf(BUYER) == 98e6, "premium not collected");
        require(book.usedFillIds(quote.fillId), "fill not consumed");
    }

    function testRejectsReplay() public {
        ShadowOptionBook.ShadowQuote memory quote = _quote();
        bytes memory signature = _sign(quote);
        vm.prank(BUYER);
        book.fillShadow(quote, signature);

        vm.prank(BUYER);
        (bool ok,) = address(book).call(abi.encodeCall(book.fillShadow, (quote, signature)));
        require(!ok, "replay accepted");
    }

    function _quote() private view returns (ShadowOptionBook.ShadowQuote memory) {
        return ShadowOptionBook.ShadowQuote({
            fillId: keccak256("fill"),
            sourceHash: keccak256("source"),
            asset: bytes32("ETH"),
            buyer: BUYER,
            isCall: false,
            strikeE8: 2_000e8,
            expiry: uint64(block.timestamp + 7 days),
            validUntil: uint64(block.timestamp + 1 minutes),
            contractsE6: 1e6,
            premiumUsdc: 2e6
        });
    }

    function _sign(ShadowOptionBook.ShadowQuote memory quote) private returns (bytes memory) {
        bytes32 typeHash = keccak256(
            "ShadowQuote(bytes32 fillId,bytes32 sourceHash,bytes32 asset,address buyer,bool isCall,uint128 strikeE8,uint64 expiry,uint64 validUntil,uint128 contractsE6,uint128 premiumUsdc)"
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", book.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }
}
