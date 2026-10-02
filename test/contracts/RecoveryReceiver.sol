// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface IRecoverableDeposit {
    function recoverNative() external;
}

// Shared test fixture for both OpenZeppelin/compiler versions. Never deployed live.
contract RecoveryReceiver {
    IRecoverableDeposit public target;
    bool public reentryBlocked;
    bool public rejectPayment;

    function configure(IRecoverableDeposit forwarder, bool reject) external {
        target = forwarder;
        rejectPayment = reject;
    }

    function recoverNative() external { target.recoverNative(); }

    receive() external payable {
        require(!rejectPayment, "Payment rejected");
        (bool ok, bytes memory reason) = address(target).call(abi.encodeWithSignature("recoverNative()"));
        bytes32 errorHash = keccak256(reason);
        reentryBlocked = !ok && (
            errorHash == keccak256(abi.encodeWithSignature("Error(string)", "ReentrancyGuard: reentrant call"))
            || errorHash == keccak256(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"))
        );
    }
}
