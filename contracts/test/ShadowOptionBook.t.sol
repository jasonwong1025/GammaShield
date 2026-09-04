// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockUSDC} from "./MockUSDC.sol";
import {ShadowOptionBook} from "../src/ShadowOptionBook.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function prank(address) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter) external;
}

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

        vm.expectEmit(true, true, true, true, address(book));
        emit ShadowOrderFilled(0, quote.fillId, quote.sourceHash, BUYER, quote.asset, quote.isCall, quote.strikeE8, quote.expiry, quote.contractsE6, quote.premiumUsdc);
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

    function testAttestedCloseReturnsProceedsAndRetiresThePosition() public {
        ShadowOptionBook.ShadowQuote memory quote = _quote();
        bytes memory fillSignature = _sign(quote);
        vm.prank(BUYER);
        uint256 positionId = book.fillShadow(quote, fillSignature);
        require(token.balanceOf(BUYER) == 98e6, "premium not collected");

        ShadowOptionBook.ShadowClose memory close = _close(positionId, 1_500_000);
        bytes memory closeSignature = _signClose(close);
        vm.prank(BUYER);
        uint128 proceeds = book.closeShadow(close, closeSignature);

        require(proceeds == 1_500_000, "wrong proceeds");
        require(token.balanceOf(BUYER) == 99_500_000, "proceeds not paid");
        require(book.closedAt(positionId) == block.timestamp, "position still open");
        require(book.usedCloseIds(close.closeId), "close not consumed");
    }

    function testCloseIsFullSizeOnceOnlyAndPaysNothingWhenWorthless() public {
        ShadowOptionBook.ShadowQuote memory quote = _quote();
        bytes memory fillSignature = _sign(quote);
        vm.prank(BUYER);
        uint256 positionId = book.fillShadow(quote, fillSignature);

        ShadowOptionBook.ShadowClose memory halfSize = _close(positionId, 1e6);
        halfSize.contractsE6 = quote.contractsE6 / 2;
        bytes memory halfSignature = _signClose(halfSize);
        vm.prank(BUYER);
        (bool halfOk,) = address(book).call(abi.encodeCall(book.closeShadow, (halfSize, halfSignature)));
        require(!halfOk, "partial close accepted");

        // A hedge that expired out of the money is worth nothing. That is an
        // outcome the book has to record, not an error.
        ShadowOptionBook.ShadowClose memory worthless = _close(positionId, 0);
        bytes memory worthlessSignature = _signClose(worthless);
        vm.prank(BUYER);
        require(book.closeShadow(worthless, worthlessSignature) == 0, "worthless close paid out");
        require(token.balanceOf(BUYER) == 98e6, "balance moved on a worthless close");

        ShadowOptionBook.ShadowClose memory second = _close(positionId, 1e6);
        second.closeId = keccak256("second close");
        bytes memory secondSignature = _signClose(second);
        vm.prank(BUYER);
        (bool secondOk,) = address(book).call(abi.encodeCall(book.closeShadow, (second, secondSignature)));
        require(!secondOk, "double close accepted");
    }

    function testCloseRejectsAnUnsignedMarkAndAStranger() public {
        ShadowOptionBook.ShadowQuote memory quote = _quote();
        bytes memory fillSignature = _sign(quote);
        vm.prank(BUYER);
        uint256 positionId = book.fillShadow(quote, fillSignature);
        ShadowOptionBook.ShadowClose memory close = _close(positionId, 1e6);
        bytes memory closeSignature = _signClose(close);

        // Signed by someone who is not the attester.
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(0xBADBAD, keccak256("anything"));
        bytes memory forged = abi.encodePacked(r, sig, v);
        vm.prank(BUYER);
        (bool forgedOk,) = address(book).call(abi.encodeCall(book.closeShadow, (close, forged)));
        require(!forgedOk, "forged mark accepted");

        // Correctly signed, but the caller does not hold the position.
        vm.prank(address(0xDEAD));
        (bool strangerOk,) = address(book).call(abi.encodeCall(book.closeShadow, (close, closeSignature)));
        require(!strangerOk, "stranger closed someone else's position");
    }

    function _close(uint256 positionId, uint128 proceedsUsdc) private view returns (ShadowOptionBook.ShadowClose memory) {
        return ShadowOptionBook.ShadowClose({
            closeId: keccak256(abi.encode("close", positionId, proceedsUsdc)),
            positionId: positionId,
            seller: BUYER,
            validUntil: uint64(block.timestamp + 1 minutes),
            contractsE6: 1e6,
            proceedsUsdc: proceedsUsdc
        });
    }

    function _signClose(ShadowOptionBook.ShadowClose memory close) private returns (bytes memory) {
        bytes32 typeHash = keccak256(
            "ShadowClose(bytes32 closeId,uint256 positionId,address seller,uint64 validUntil,uint128 contractsE6,uint128 proceedsUsdc)"
        );
        bytes32 structHash = keccak256(
            abi.encode(typeHash, close.closeId, close.positionId, close.seller, close.validUntil, close.contractsE6, close.proceedsUsdc)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", book.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_KEY, digest);
        return abi.encodePacked(r, s, v);
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
