// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {DepositFixture, TestPool, DepositBase, IERC20} from "../shared/DepositFixture.sol";
import {PrivacyPoolsDeposit, PrivacyPoolsDepositFactory} from "../../../contracts/protocols/PrivacyPoolsDeposit.sol";
import {DepositConfig, DepositQuote} from "../../../contracts/DepositBase.sol";
import {DepositFactory, TokenPolicy} from "../../../contracts/DepositFactory.sol";

contract PrivacyPoolsStub is TestPool {
    struct Proof { uint256[2] pA; uint256[2][2] pB; uint256[2] pC; uint256[4] pubSignals; }
    struct NoteData { bytes32 hint; bytes data; }
    constructor(IERC20 asset) TestPool(asset) {}
    function deposit(Proof calldata proof, NoteData calldata, bytes calldata) external payable {
        require(proof.pubSignals[1] == uint256(uint160(address(token))));
        _take(proof.pubSignals[2]);
    }
}

abstract contract PrivacyPoolsFixture is DepositFixture {
    bytes internal callData;

    function _setUpProtocol() internal override {
        pool = new PrivacyPoolsStub(token);
        TokenPolicy[] memory policies = new TokenPolicy[](1);
        policies[0] = TokenPolicy(token, uint120(gasCharge), 0);
        factory = new PrivacyPoolsDepositFactory(address(pool), policies);
        factoryAddress = address(factory);
        PrivacyPoolsStub.Proof memory proof;
        proof.pubSignals[0] = 123; // This stub tests accounting, not cryptography.
        proof.pubSignals[1] = uint256(uint160(address(token)));
        proof.pubSignals[2] = quote - quote / 1_000 - gasCharge;
        PrivacyPoolsStub.NoteData memory note;
        callData = abi.encodeCall(PrivacyPoolsStub.deposit, (proof, note, hex"1234"));
        config = DepositConfig(abi.encode(keccak256(callData)), recovery, relayer, feeRecipient);
    }

    function _protocolData() internal view override returns (bytes memory) { return callData; }
    function _expectedCallHash(uint256) internal view override returns (bytes32) { return keccak256(callData); }
}
