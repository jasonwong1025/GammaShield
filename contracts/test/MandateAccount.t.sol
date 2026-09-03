// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockUSDC} from "./MockUSDC.sol";
import {ShadowOptionBook} from "../src/ShadowOptionBook.sol";
import {IShadowFill, IThetanutsOptionBook, MandateAccount, PackedUserOperation} from "../src/MandateAccount.sol";

interface VmMandate {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function prank(address msgSender) external;
    function warp(uint256 newTimestamp) external;
    function chainId(uint256 newChainId) external;
    function etch(address target, bytes calldata code) external;
}

contract MockThetanutsOptionBook {
    function fillOrder(IThetanutsOptionBook.Order calldata, bytes calldata, address) external pure returns (address) {
        return address(0xBEEF);
    }
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

    function testAgentCanExecuteOnlyAfterPersistentRisk() public {
        MandateAccount.Mandate memory mandate = _mandate(3e6, 5e6);
        bytes memory mandateSignature = _sign(OWNER_KEY, _typed(account.mandateDomainSeparator(), account.mandateHash(mandate)));
        MandateAccount.RiskAttestation memory risk = _risk(account.mandateHash(mandate));
        bytes memory riskSignature = _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(risk)));
        IShadowFill.ShadowQuote memory quote = _quote(2e6, 1e6);

        require(_validateAgent(mandate, risk, riskSignature, quote, _signQuote(quote), keccak256("unregistered mandate")) == 1, "unregistered mandate accepted");
        vm.prank(owner);
        account.registerMandate(mandate, mandateSignature);
        require(_validateRiskRecord(mandate, risk, riskSignature, keccak256("risk observation")) != 1, "risk observation rejected");
        account.recordRisk(account.mandateHash(mandate), risk, riskSignature);
        require(_validateAgent(mandate, risk, riskSignature, quote, _signQuote(quote), keccak256("risk too new")) == 1, "risk persistence bypassed");
        _renewRisk(mandate);
        _renewRisk(mandate);
        _renewRisk(mandate);
        _renewRisk(mandate);
        _renewRisk(mandate);
        quote = _quote(2e6, 1e6);
        bytes memory quoteSignature = _signQuote(quote);
        MandateAccount.RiskAttestation memory staleRisk = _risk(account.mandateHash(mandate));
        staleRisk.observedAt = uint64(block.timestamp - 3 minutes - 1);
        bytes memory staleRiskSignature = _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(staleRisk)));
        require(_validateAgent(mandate, staleRisk, staleRiskSignature, quote, quoteSignature, keccak256("stale final risk")) == 1, "stale final risk accepted");
        risk = _risk(account.mandateHash(mandate));
        riskSignature = _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(risk)));
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
        MandateAccount.RiskAttestation memory risk = _risk(account.mandateHash(mandate));
        bytes memory riskSignature = _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(risk)));
        account.recordRisk(account.mandateHash(mandate), risk, riskSignature);
        _renewRisk(mandate);
        _renewRisk(mandate);
        _renewRisk(mandate);
        _renewRisk(mandate);
        _renewRisk(mandate);
        IShadowFill.ShadowQuote memory quote = _quote(2e6, 1e6);
        risk = _risk(account.mandateHash(mandate));
        riskSignature = _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(risk)));
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

    function testRiskGapResetsPersistenceTimer() public {
        MandateAccount.Mandate memory mandate = _mandate(3e6, 5e6);
        bytes32 mandateHash = account.mandateHash(mandate);
        bytes memory mandateSignature = _sign(OWNER_KEY, _typed(account.mandateDomainSeparator(), mandateHash));
        vm.prank(owner);
        account.registerMandate(mandate, mandateSignature);
        MandateAccount.RiskAttestation memory first = _risk(mandateHash);
        account.recordRisk(mandateHash, first, _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(first))));

        vm.warp(block.timestamp + 3 minutes + 1);
        MandateAccount.RiskAttestation memory second = _risk(mandateHash);
        account.recordRisk(mandateHash, second, _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(second))));
        (,, uint64 eligibleSince,,) = account.riskStates(mandateHash);
        require(eligibleSince == block.timestamp, "risk gap did not reset persistence");
        IShadowFill.ShadowQuote memory quote = _quote(2e6, 1e6);
        require(_validateAgent(mandate, second, _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(second))), quote, _signQuote(quote), keccak256("risk gap")) == 1, "risk gap bypassed");
    }

    function testSubThresholdObservationResetsPersistenceTimer() public {
        MandateAccount.Mandate memory mandate = _mandate(3e6, 5e6);
        bytes32 mandateHash = account.mandateHash(mandate);
        bytes memory mandateSignature = _sign(OWNER_KEY, _typed(account.mandateDomainSeparator(), mandateHash));
        vm.prank(owner);
        account.registerMandate(mandate, mandateSignature);
        MandateAccount.RiskAttestation memory high = _risk(mandateHash);
        account.recordRisk(mandateHash, high, _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(high))));

        vm.warp(block.timestamp + 1 minutes);
        MandateAccount.RiskAttestation memory low = _risk(mandateHash);
        low.riskScoreBps = 7_499;
        bytes memory lowSignature = _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(low)));
        require(_validateRiskRecord(mandate, low, lowSignature, keccak256("sub-threshold observation")) != 1, "sub-threshold observation rejected");
        account.recordRisk(mandateHash, low, lowSignature);
        (,, uint64 eligibleSince,,) = account.riskStates(mandateHash);
        require(eligibleSince == 0, "sub-threshold risk did not reset persistence");

        high = _risk(mandateHash);
        account.recordRisk(mandateHash, high, _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(high))));
        (,, eligibleSince,,) = account.riskStates(mandateHash);
        require(eligibleSince == block.timestamp, "new high-risk period did not restart persistence");
        IShadowFill.ShadowQuote memory quote = _quote(2e6, 1e6);
        require(_validateAgent(mandate, high, _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(high))), quote, _signQuote(quote), keccak256("post-reset persistence")) == 1, "sub-threshold gap bypassed");
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
        require(account.mandateHash(mandate) == 0xbbb613502d4cd1b0fa18511eaa9f3ff7f5ce7ed74a365ff969d07ba3e83e3abb, "EIP-712 hash mismatch");
    }

    function testThetanutsAdapterAcceptsOnlyAFreshBoundedPutFill() public {
        vm.chainId(8453);
        address baseUsdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        address baseBook = 0x1bDff855d6811728acaDC00989e79143a2bdfDed;
        MockThetanutsOptionBook mockBook = new MockThetanutsOptionBook();
        vm.etch(baseUsdc, address(token).code);
        vm.etch(baseBook, address(mockBook).code);
        MockUSDC(baseUsdc).mint(address(account), 100e6);

        MandateAccount.Mandate memory mandate = _mandate(3e6, 5e6);
        mandate.optionBook = baseBook;
        mandate.collateral = baseUsdc;
        bytes32 mandateHash = account.mandateHash(mandate);
        bytes memory mandateSignature = _sign(OWNER_KEY, _typed(account.mandateDomainSeparator(), mandateHash));
        vm.prank(owner);
        account.registerMandate(mandate, mandateSignature);
        MandateAccount.RiskAttestation memory risk = _risk(mandateHash);
        account.recordRisk(mandateHash, risk, _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(risk))));
        _renewRisk(mandate);
        _renewRisk(mandate);
        _renewRisk(mandate);
        _renewRisk(mandate);
        _renewRisk(mandate);

        uint256[] memory strikes = new uint256[](1);
        strikes[0] = 2_000e8;
        IThetanutsOptionBook.Order memory order = IThetanutsOptionBook.Order({
            maker: owner, orderExpiryTimestamp: block.timestamp + 1 minutes, collateral: baseUsdc, isCall: false,
            priceFeed: 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70, implementation: 0x7355EB92dfb0503DB558a70c10843618932ab290,
            isLong: false, maxCollateralUsable: 10e6, strikes: strikes, expiry: block.timestamp + 7 days,
            price: 1e8, numContracts: 1e6, extraOptionData: ""
        });
        bytes memory fillData = abi.encodeWithSelector(IThetanutsOptionBook.fillOrder.selector, order, _sign(QUOTE_KEY, keccak256("maker")), address(0));
        MandateAccount.ThetanutsQuote memory quote = MandateAccount.ThetanutsQuote({
            mandateHash: mandateHash, fillCalldataHash: keccak256(fillData), premium: 1e6, contracts: 1e6,
            observedAt: uint64(block.timestamp), validUntil: uint64(block.timestamp + 1 minutes)
        });
        bytes memory quoteSignature = _sign(RISK_KEY, _typed(account.thetanutsQuoteDomainSeparator(), _thetanutsQuoteHash(quote)));
        risk = _risk(mandateHash);
        account.executeThetanuts(mandateHash, risk, _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(risk))), quote, quoteSignature, fillData);
        (,, uint256 spent,) = account.controls(mandateHash);
        require(spent == 1e6, "Thetanuts fill was not accounted");
    }

    function testCloseCreditsTheLossMeterAndNeverCreatesBudget() public {
        MandateAccount.Mandate memory mandate = _mandate(3e6, 5e6);
        bytes32 mandateHash = account.mandateHash(mandate);
        uint256 positionId = _open(mandate);
        (,, uint256 spent,) = account.controls(mandateHash);
        require(spent == 2e6, "fill not metered");

        IShadowFill.ShadowClose memory close = _shadowClose(positionId, 1_500_000);
        MandateAccount.ShadowCloseAttestation memory attestation = _closeAttestation(mandateHash, close);
        bytes memory attestationSignature = _signCloseAttestation(attestation);
        bytes memory closeSignature = _signBookClose(close);
        require(_validateClose(mandateHash, attestation, attestationSignature, close, closeSignature, keccak256("close")) != 1, "close rejected");
        account.executeShadowClose(mandateHash, attestation, attestationSignature, close, closeSignature);

        (,, spent,) = account.controls(mandateHash);
        require(spent == 500_000, "exit proceeds not credited");
        require(token.balanceOf(address(account)) == 99_500_000, "proceeds not received");
    }

    function testCloseCreditCannotExceedWhatThePolicySpent() public {
        // A mark above the premium paid is a winning hedge, not extra budget.
        token.mint(address(book), 10e6);
        MandateAccount.Mandate memory mandate = _mandate(3e6, 5e6);
        bytes32 mandateHash = account.mandateHash(mandate);
        uint256 positionId = _open(mandate);

        IShadowFill.ShadowClose memory close = _shadowClose(positionId, 9e6);
        MandateAccount.ShadowCloseAttestation memory attestation = _closeAttestation(mandateHash, close);
        account.executeShadowClose(mandateHash, attestation, _signCloseAttestation(attestation), close, _signBookClose(close));

        (,, uint256 spent,) = account.controls(mandateHash);
        require(spent == 0, "loss meter went below zero");
    }

    function testCloseNeedsNoHotRiskButObeysPause() public {
        MandateAccount.Mandate memory mandate = _mandate(3e6, 5e6);
        bytes32 mandateHash = account.mandateHash(mandate);
        uint256 positionId = _open(mandate);

        // Let every risk observation lapse. An exit must still be reachable —
        // gating de-risking on hot risk evidence would trap the position.
        vm.warp(block.timestamp + 1 days - 1 hours);
        IShadowFill.ShadowClose memory close = _shadowClose(positionId, 1e6);
        MandateAccount.ShadowCloseAttestation memory attestation = _closeAttestation(mandateHash, close);
        bytes memory attestationSignature = _signCloseAttestation(attestation);
        bytes memory closeSignature = _signBookClose(close);
        require(_validateClose(mandateHash, attestation, attestationSignature, close, closeSignature, keccak256("cold close")) != 1, "cold close rejected");

        vm.prank(owner);
        account.pauseMandate(mandateHash);
        require(_validateClose(mandateHash, attestation, attestationSignature, close, closeSignature, keccak256("paused close")) == 1, "paused close accepted");
    }

    /// The account is the trend's only storage: nothing off-chain survives a
    /// worker restart. So the ring has to stay ordered, has to wrap, and has
    /// to be shallow while it is still filling — a caller must be able to tell
    /// "no change" from "not enough history yet".
    function testRiskHistoryKeepsOrderedSamplesAndWrapsTheRing() public {
        MandateAccount.Mandate memory mandate = _mandate(3e6, 5e6);
        bytes32 mandateHash = account.mandateHash(mandate);
        bytes memory mandateSignature = _sign(OWNER_KEY, _typed(account.mandateDomainSeparator(), mandateHash));
        vm.prank(owner);
        account.registerMandate(mandate, mandateSignature);

        require(account.getRiskHistory(mandateHash).length == 0, "history started non-empty");

        // 35 hourly observations against a 32-slot ring: the ring wraps and the
        // three oldest samples fall off the back.
        for (uint256 i = 0; i < 35; i++) {
            MandateAccount.RiskAttestation memory sample = _risk(mandateHash);
            sample.riskScoreBps = uint16(1_000 + i * 100);
            sample.positionRiskScoreBps = uint16(2_000 + i * 100);
            account.recordRisk(mandateHash, sample, _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(sample))));
            if (i < 3) require(account.getRiskHistory(mandateHash).length == i + 1, "ring was not shallow while filling");
            vm.warp(block.timestamp + 1 hours);
        }

        MandateAccount.RiskSample[] memory history = account.getRiskHistory(mandateHash);
        require(history.length == 32, "ring did not cap at its slot count");
        require(account.riskObservationCount(mandateHash) == 35, "observation count wrong");
        // Oldest first, and the first three writes are gone.
        require(history[0].bookScoreBps == 1_000 + 3 * 100, "oldest retained sample wrong");
        require(history[31].bookScoreBps == 1_000 + 34 * 100, "newest sample wrong");
        require(history[31].positionScoreBps == 2_000 + 34 * 100, "position score not retained");
        for (uint256 i = 1; i < history.length; i++) {
            require(history[i].observedAt > history[i - 1].observedAt, "samples out of order");
        }

        // A backdated observation cannot rewrite newer state, so a trend can
        // never be walked backwards by replaying an old attestation.
        vm.warp(block.timestamp - 2 hours);
        MandateAccount.RiskAttestation memory stale = _risk(mandateHash);
        bytes memory staleSignature = _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(stale)));
        try account.recordRisk(mandateHash, stale, staleSignature) {
            revert("a backdated observation was accepted");
        } catch Error(string memory reason) {
            require(keccak256(bytes(reason)) == keccak256("risk observation stale"), "wrong revert reason");
        }
        require(account.riskObservationCount(mandateHash) == 35, "a rejected observation still grew the ring");
    }

    function testRollRequiresPersistentRiskAndStaysInsideTheTotalCap() public {
        MandateAccount.Mandate memory mandate = _mandate(3e6, 5e6);
        mandate.minExecutionIntervalSeconds = 0;
        bytes32 mandateHash = account.mandateHash(mandate);
        uint256 positionId = _open(mandate);

        MandateAccount.RollRequest memory request = _roll(mandateHash, positionId, 1_500_000, 2e6);
        require(_validateRoll(mandateHash, request, keccak256("hot roll")) != 1, "roll with hot risk rejected");

        // A roll is armed by the POSITION's own risk, so cold per-contract
        // evidence must not validate even while the book is still hot.
        MandateAccount.RollRequest memory coldPosition = _roll(mandateHash, positionId, 1_500_000, 2e6);
        coldPosition.risk.positionRiskScoreBps = 7_499;
        coldPosition.riskSignature = _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(coldPosition.risk)));
        require(_validateRoll(mandateHash, coldPosition, keccak256("cold position")) == 1, "roll bypassed the position gate");

        // The mirror image is deliberately allowed: a calm book does not stop
        // an expiring position that is still risky on its own terms from being
        // replaced. This is the case a book-level gate used to block wrongly.
        MandateAccount.RollRequest memory calmBook = _roll(mandateHash, positionId, 1_500_000, 2e6);
        calmBook.risk.riskScoreBps = 0;
        calmBook.riskSignature = _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(calmBook.risk)));
        require(_validateRoll(mandateHash, calmBook, keccak256("calm book")) != 1, "a calm book blocked a risky position's roll");

        // 2e6 spent, 1.5e6 recovered, so a 4.6e6 replacement breaks the 5e6 cap.
        MandateAccount.RollRequest memory oversized = _roll(mandateHash, positionId, 1_500_000, 4_600_000);
        require(_validateRoll(mandateHash, oversized, keccak256("oversized roll")) == 1, "roll bypassed the total cap");

        uint256 rolledId = account.executeShadowRoll(mandateHash, request);
        (,, uint256 spent, uint64 lastExecutionAt) = account.controls(mandateHash);
        (,, address buyer,,,,, uint128 premiumUsdc) = book.positions(rolledId);
        require(rolledId == positionId + 1 && buyer == address(account) && premiumUsdc == 2e6, "replacement leg not opened");
        require(book.closedAt(positionId) == block.timestamp, "near leg not closed");
        require(spent == 2_500_000, "roll accounting wrong");
        require(lastExecutionAt == block.timestamp, "roll did not arm the cooldown");
    }

    function _open(MandateAccount.Mandate memory mandate) private returns (uint256 positionId) {
        bytes32 mandateHash = account.mandateHash(mandate);
        bytes memory mandateSignature = _sign(OWNER_KEY, _typed(account.mandateDomainSeparator(), mandateHash));
        vm.prank(owner);
        account.registerMandate(mandate, mandateSignature);
        MandateAccount.RiskAttestation memory risk = _risk(mandateHash);
        account.recordRisk(mandateHash, risk, _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(risk))));
        _renewRisk(mandate);
        _renewRisk(mandate);
        _renewRisk(mandate);
        _renewRisk(mandate);
        _renewRisk(mandate);
        IShadowFill.ShadowQuote memory quote = _quote(2e6, 1e6);
        risk = _risk(mandateHash);
        positionId = account.executeShadow(
            mandateHash, risk, _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(risk))), quote, _signQuote(quote)
        );
    }

    function _roll(bytes32 mandateHash, uint256 positionId, uint128 proceedsUsdc, uint128 premiumUsdc)
        private
        returns (MandateAccount.RollRequest memory)
    {
        IShadowFill.ShadowClose memory close = _shadowClose(positionId, proceedsUsdc);
        MandateAccount.ShadowCloseAttestation memory attestation = _closeAttestation(mandateHash, close);
        MandateAccount.RiskAttestation memory risk = _risk(mandateHash);
        IShadowFill.ShadowQuote memory quote = _quote(premiumUsdc, 1e6);
        quote.fillId = keccak256(abi.encode("roll", positionId, premiumUsdc));
        return MandateAccount.RollRequest({
            risk: risk,
            riskSignature: _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(risk))),
            attestation: attestation,
            attestationSignature: _signCloseAttestation(attestation),
            close: close,
            closeSignature: _signBookClose(close),
            quote: quote,
            quoteSignature: _signQuote(quote)
        });
    }

    function _shadowClose(uint256 positionId, uint128 proceedsUsdc) private view returns (IShadowFill.ShadowClose memory) {
        return IShadowFill.ShadowClose({
            closeId: keccak256(abi.encode("close", positionId, proceedsUsdc)),
            positionId: positionId,
            seller: address(account),
            validUntil: uint64(block.timestamp + 1 minutes),
            contractsE6: 1e6,
            proceedsUsdc: proceedsUsdc
        });
    }

    function _closeAttestation(bytes32 mandateHash, IShadowFill.ShadowClose memory close)
        private
        view
        returns (MandateAccount.ShadowCloseAttestation memory)
    {
        return MandateAccount.ShadowCloseAttestation({
            mandateHash: mandateHash,
            closeId: close.closeId,
            positionId: close.positionId,
            contractsE6: close.contractsE6,
            proceedsUsdc: close.proceedsUsdc,
            observedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 minutes)
        });
    }

    function _signCloseAttestation(MandateAccount.ShadowCloseAttestation memory attestation) private returns (bytes memory) {
        bytes32 typeHash = keccak256(
            "ShadowClose(bytes32 mandateHash,bytes32 closeId,uint256 positionId,uint128 contractsE6,uint128 proceedsUsdc,uint64 observedAt,uint64 validUntil)"
        );
        bytes32 structHash = keccak256(abi.encode(
            typeHash, attestation.mandateHash, attestation.closeId, attestation.positionId,
            attestation.contractsE6, attestation.proceedsUsdc, attestation.observedAt, attestation.validUntil
        ));
        return _sign(RISK_KEY, _typed(account.shadowCloseDomainSeparator(), structHash));
    }

    function _signBookClose(IShadowFill.ShadowClose memory close) private returns (bytes memory) {
        bytes32 typeHash = keccak256(
            "ShadowClose(bytes32 closeId,uint256 positionId,address seller,uint64 validUntil,uint128 contractsE6,uint128 proceedsUsdc)"
        );
        bytes32 structHash = keccak256(abi.encode(
            typeHash, close.closeId, close.positionId, close.seller, close.validUntil, close.contractsE6, close.proceedsUsdc
        ));
        return _sign(QUOTE_KEY, _typed(book.domainSeparator(), structHash));
    }

    function _validateClose(
        bytes32 mandateHash,
        MandateAccount.ShadowCloseAttestation memory attestation,
        bytes memory attestationSignature,
        IShadowFill.ShadowClose memory close,
        bytes memory closeSignature,
        bytes32 userOpHash
    ) private returns (uint256) {
        PackedUserOperation memory userOp = PackedUserOperation({
            sender: address(account), nonce: 0, initCode: "",
            callData: abi.encodeCall(account.executeShadowClose, (mandateHash, attestation, attestationSignature, close, closeSignature)),
            accountGasLimits: bytes32(0), preVerificationGas: 0, gasFees: bytes32(0), paymasterAndData: "",
            signature: _sign(AGENT_KEY, userOpHash)
        });
        return account.validateUserOp(userOp, userOpHash, 0);
    }

    function _validateRoll(bytes32 mandateHash, MandateAccount.RollRequest memory request, bytes32 userOpHash)
        private
        returns (uint256)
    {
        PackedUserOperation memory userOp = PackedUserOperation({
            sender: address(account), nonce: 0, initCode: "",
            callData: abi.encodeCall(account.executeShadowRoll, (mandateHash, request)),
            accountGasLimits: bytes32(0), preVerificationGas: 0, gasFees: bytes32(0), paymasterAndData: "",
            signature: _sign(AGENT_KEY, userOpHash)
        });
        return account.validateUserOp(userOp, userOpHash, 0);
    }

    function _mandate(uint256 perFill, uint256 total) private view returns (MandateAccount.Mandate memory) {
        return MandateAccount.Mandate({
            owner: owner, account: address(account), agent: agent, optionBook: address(book), collateral: address(token), asset: bytes32("ETH"), side: 1,
            maxPremiumPerFill: perFill, maxPremiumTotal: total, maxContractsPerFill: 2e6,
            minTenorSeconds: 1 days, maxTenorSeconds: 14 days, riskThresholdBps: 7_500,
            positionRiskThresholdBps: 7_500, persistenceSeconds: 10 minutes, minExecutionIntervalSeconds: 1 hours,
            validAfter: uint64(block.timestamp - 1), expiresAt: uint64(block.timestamp + 1 days), nonce: 1
        });
    }

    function _risk(bytes32 mandateHash) private view returns (MandateAccount.RiskAttestation memory) {
        return MandateAccount.RiskAttestation({
            mandateHash: mandateHash, riskScoreBps: 8_000, positionRiskScoreBps: 8_000,
            observedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 3 minutes), persistenceSeconds: 10 minutes
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

    function _validateRiskRecord(
        MandateAccount.Mandate memory mandate,
        MandateAccount.RiskAttestation memory risk,
        bytes memory riskSignature,
        bytes32 userOpHash
    ) private returns (uint256) {
        PackedUserOperation memory userOp = PackedUserOperation({
            sender: address(account), nonce: 0, initCode: "",
            callData: abi.encodeCall(account.recordRisk, (account.mandateHash(mandate), risk, riskSignature)),
            accountGasLimits: bytes32(0), preVerificationGas: 0, gasFees: bytes32(0), paymasterAndData: "",
            signature: _sign(AGENT_KEY, userOpHash)
        });
        return account.validateUserOp(userOp, userOpHash, 0);
    }

    function _renewRisk(MandateAccount.Mandate memory mandate) private {
        vm.warp(block.timestamp + 2 minutes);
        bytes32 mandateHash = account.mandateHash(mandate);
        MandateAccount.RiskAttestation memory risk = _risk(mandateHash);
        account.recordRisk(mandateHash, risk, _sign(RISK_KEY, _typed(account.riskDomainSeparator(), _riskHash(risk))));
    }

    function _signQuote(IShadowFill.ShadowQuote memory quote) private returns (bytes memory) {
        bytes32 typeHash = keccak256("ShadowQuote(bytes32 fillId,bytes32 sourceHash,bytes32 asset,address buyer,bool isCall,uint128 strikeE8,uint64 expiry,uint64 validUntil,uint128 contractsE6,uint128 premiumUsdc)");
        bytes32 structHash = keccak256(abi.encode(typeHash, quote.fillId, quote.sourceHash, quote.asset, quote.buyer, quote.isCall, quote.strikeE8, quote.expiry, quote.validUntil, quote.contractsE6, quote.premiumUsdc));
        return _sign(QUOTE_KEY, _typed(book.domainSeparator(), structHash));
    }

    function _riskHash(MandateAccount.RiskAttestation memory risk) private pure returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("RiskAttestation(bytes32 mandateHash,uint16 riskScoreBps,uint16 positionRiskScoreBps,uint64 observedAt,uint64 validUntil,uint64 persistenceSeconds)"),
            risk.mandateHash, risk.riskScoreBps, risk.positionRiskScoreBps, risk.observedAt, risk.validUntil, risk.persistenceSeconds
        ));
    }

    function _thetanutsQuoteHash(MandateAccount.ThetanutsQuote memory quote) private pure returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("ThetanutsQuote(bytes32 mandateHash,bytes32 fillCalldataHash,uint256 premium,uint256 contracts,uint64 observedAt,uint64 validUntil)"),
            quote.mandateHash, quote.fillCalldataHash, quote.premium, quote.contracts, quote.observedAt, quote.validUntil
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
