// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockUSDC} from "./MockUSDC.sol";
import {ShadowOptionBook} from "../src/ShadowOptionBook.sol";
import {IShadowFill, MandateAccount, PackedUserOperation} from "../src/MandateAccount.sol";

interface VmMandate {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function prank(address msgSender) external;
    function warp(uint256 newTimestamp) external;
}

contract MandateAccountTest {
    VmMandate private constant vm = VmMandate(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant OWNER_KEY = 0xA11CE;
    uint256 private constant AGENT_KEY = 0xB0B;
    uint256 private constant RISK_KEY = 0xCAFE;
    uint256 private constant QUOTE_KEY = 0xD00D;

    MockUSDC private token;
    ShadowOptionBook private book;
    MandateAccount private account;
    address private owner;
    address private agent;

    function setUp() public {
        vm.warp(1 days);
        owner = vm.addr(OWNER_KEY);
        agent = vm.addr(AGENT_KEY);
        token = new MockUSDC();
        book = new ShadowOptionBook(address(token), vm.addr(QUOTE_KEY));
        account = new MandateAccount(address(this), owner, vm.addr(RISK_KEY));
        token.mint(address(account), 100e6);
    }

    function testAgentCanExecuteOnlySignedBoundedFill() public {
        MandateAccount.Mandate memory mandate = _mandate(3e6, 5e6);
        bytes memory mandateSignature = _sign(OWNER_KEY, _typed(account.mandateDomainSeparator(), account.mandateHash(mandate)));
        IShadowFill.ShadowQuote memory quote = _quote(2e6, 1e6);
        bytes memory quoteSignature = _signQuote(quote);
        MandateAccount.RiskAttestation memory risk = _risk(account.mandateHash(mandate));
        bytes memory riskSignature = _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(risk)));

        require(_validateAgent(mandate, risk, riskSignature, quote, quoteSignature, keccak256("unregistered mandate")) == 1, "unregistered mandate accepted");
        vm.prank(owner);
        account.registerMandate(mandate, mandateSignature);
        require(_validateAgent(mandate, risk, riskSignature, quote, quoteSignature, keccak256("agent shadow fill")) != 1, "agent operation rejected");
        uint256 positionId = account.executeShadow(account.mandateHash(mandate), risk, riskSignature, quote, quoteSignature);
        (,, address buyer,,,,, uint128 premiumUsdc) = book.positions(positionId);
        (,, uint256 spent,) = account.controls(account.mandateHash(mandate));
        require(buyer == address(account), "wrong buyer");
        require(premiumUsdc == 2e6 && spent == 2e6, "incorrect fill accounting");
        require(token.balanceOf(address(account)) == 98e6, "premium not paid");
    }

    function testAgentCannotExceedSignedPremiumCap() public {
        MandateAccount.Mandate memory mandate = _mandate(1e6, 5e6);
        bytes memory mandateSignature = _sign(OWNER_KEY, _typed(account.mandateDomainSeparator(), account.mandateHash(mandate)));
        vm.prank(owner);
        account.registerMandate(mandate, mandateSignature);
        IShadowFill.ShadowQuote memory quote = _quote(2e6, 1e6);
        MandateAccount.RiskAttestation memory risk = _risk(account.mandateHash(mandate));
        bytes memory riskSignature = _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(risk)));
        require(_validateAgent(mandate, risk, riskSignature, quote, _signQuote(quote), keccak256("too expensive")) == 1, "premium cap bypassed");
    }

    function testOwnerCanRevokeAndBlockAgentFill() public {
        MandateAccount.Mandate memory mandate = _mandate(3e6, 5e6);
        bytes memory mandateSignature = _sign(OWNER_KEY, _typed(account.mandateDomainSeparator(), account.mandateHash(mandate)));
        vm.prank(owner);
        account.registerMandate(mandate, mandateSignature);
        bytes32 mandateHash = account.mandateHash(mandate);
        vm.prank(owner);
        account.revokeMandate(mandateHash);
        IShadowFill.ShadowQuote memory quote = _quote(2e6, 1e6);
        MandateAccount.RiskAttestation memory risk = _risk(mandateHash);
        bytes memory riskSignature = _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(risk)));
        require(_validateAgent(mandate, risk, riskSignature, quote, _signQuote(quote), keccak256("revoked")) == 1, "revoked mandate accepted");
    }

    function testReplacementMandateSupersedesThePreviousPolicy() public {
        MandateAccount.Mandate memory first = _mandate(3e6, 5e6);
        bytes memory firstSignature = _sign(OWNER_KEY, _typed(account.mandateDomainSeparator(), account.mandateHash(first)));
        vm.prank(owner);
        account.registerMandate(first, firstSignature);

        MandateAccount.Mandate memory replacement = _mandate(3e6, 5e6);
        replacement.nonce = 2;
        bytes memory replacementSignature = _sign(OWNER_KEY, _typed(account.mandateDomainSeparator(), account.mandateHash(replacement)));
        vm.prank(owner);
        account.registerMandate(replacement, replacementSignature);

        IShadowFill.ShadowQuote memory quote = _quote(2e6, 1e6);
        MandateAccount.RiskAttestation memory risk = _risk(account.mandateHash(first));
        bytes memory riskSignature = _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(risk)));
        require(_validateAgent(first, risk, riskSignature, quote, _signQuote(quote), keccak256("superseded")) == 1, "superseded mandate accepted");
        require(account.activeMandateHash() == account.mandateHash(replacement), "replacement not active");
    }

    function testMandateHashMatchesViemEip712Encoding() public view {
        MandateAccount.Mandate memory mandate = _mandate(3e6, 5e6);
        mandate.owner = address(1);
        mandate.account = address(2);
        mandate.agent = address(3);
        mandate.optionBook = address(4);
        mandate.collateral = address(5);
        mandate.validAfter = 86_399;
        mandate.expiresAt = 172_800;
        require(account.mandateHash(mandate) == 0xd0298dc2b570dce5bc70525d3f110abe7a2f07a0c7f2b5673cf9a4f57d5d0534, "EIP-712 hash mismatch");
    }

    function _mandate(uint256 perFill, uint256 total) private view returns (MandateAccount.Mandate memory) {
        return MandateAccount.Mandate({
            owner: owner, account: address(account), agent: agent, optionBook: address(book), collateral: address(token), asset: bytes32("ETH"), side: 1,
            maxPremiumPerFill: perFill, maxPremiumTotal: total, maxContractsPerFill: 2e6,
            minTenorSeconds: 1 days, maxTenorSeconds: 14 days, riskThresholdBps: 7_500,
            persistenceSeconds: 10 minutes, minExecutionIntervalSeconds: 1 hours,
            validAfter: uint64(block.timestamp - 1), expiresAt: uint64(block.timestamp + 1 days), nonce: 1
        });
    }

    function _risk(bytes32 mandateHash) private view returns (MandateAccount.RiskAttestation memory) {
        return MandateAccount.RiskAttestation({
            mandateHash: mandateHash, riskScoreBps: 8_000, observedAt: uint64(block.timestamp - 10 minutes),
            validUntil: uint64(block.timestamp + 1 minutes), persistenceSeconds: 10 minutes
        });
    }

    function _quote(uint128 premiumUsdc, uint128 contractsE6) private view returns (IShadowFill.ShadowQuote memory) {
        return IShadowFill.ShadowQuote({
            fillId: keccak256(abi.encode(premiumUsdc, contractsE6)), sourceHash: keccak256("source"), asset: bytes32("ETH"), buyer: address(account),
            isCall: false, strikeE8: 2_000e8, expiry: uint64(block.timestamp + 7 days), validUntil: uint64(block.timestamp + 1 minutes),
            contractsE6: contractsE6, premiumUsdc: premiumUsdc
        });
    }

    function _validateAgent(
        MandateAccount.Mandate memory mandate,
        MandateAccount.RiskAttestation memory risk,
        bytes memory riskSignature,
        IShadowFill.ShadowQuote memory quote,
        bytes memory quoteSignature,
        bytes32 userOpHash
    ) private returns (uint256) {
        PackedUserOperation memory userOp = PackedUserOperation({
            sender: address(account), nonce: 0, initCode: "",
            callData: abi.encodeCall(account.executeShadow, (account.mandateHash(mandate), risk, riskSignature, quote, quoteSignature)),
            accountGasLimits: bytes32(0), preVerificationGas: 0, gasFees: bytes32(0), paymasterAndData: "",
            signature: _sign(AGENT_KEY, userOpHash)
        });
        return account.validateUserOp(userOp, userOpHash, 0);
    }

    function _signQuote(IShadowFill.ShadowQuote memory quote) private returns (bytes memory) {
        bytes32 typeHash = keccak256("ShadowQuote(bytes32 fillId,bytes32 sourceHash,bytes32 asset,address buyer,bool isCall,uint128 strikeE8,uint64 expiry,uint64 validUntil,uint128 contractsE6,uint128 premiumUsdc)");
        bytes32 structHash = keccak256(abi.encode(typeHash, quote.fillId, quote.sourceHash, quote.asset, quote.buyer, quote.isCall, quote.strikeE8, quote.expiry, quote.validUntil, quote.contractsE6, quote.premiumUsdc));
        return _sign(QUOTE_KEY, _typed(book.domainSeparator(), structHash));
    }

    function _riskHash(MandateAccount.RiskAttestation memory risk) private pure returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("RiskAttestation(bytes32 mandateHash,uint16 riskScoreBps,uint64 observedAt,uint64 validUntil,uint64 persistenceSeconds)"),
            risk.mandateHash, risk.riskScoreBps, risk.observedAt, risk.validUntil, risk.persistenceSeconds
        ));
    }

    function _typed(bytes32 domain, bytes32 structHash) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _sign(uint256 key, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
