// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import {Test} from "forge-std/Test.sol";
import {DepositFixture, TestPool, DepositBase} from "./DepositFixture.sol";

// A separate accounting model, updated only after expected outcomes. Unexpected
// reverts fail the campaign. Expected rejection paths assert a specific error.
abstract contract DepositHandler is DepositFixture {
    uint256 internal funded;
    uint256 internal wrongFunded;
    uint256 internal nativeFunded;
    uint256 internal recovered;
    uint256 internal wrongRecovered;
    uint256 internal nativeRecovered;
    uint256 internal feePaid;
    uint256 internal poolPaid;
    uint256 public settlements;
    bool internal consumed;

    function fund(uint96 seed) public {
        uint256 amount = bound(seed, 1, quote * 3);
        token.mint(depositAddress, amount);
        funded += amount;
    }

    function fundWrongToken(uint96 seed) public {
        uint256 amount = bound(seed, 1, quote * 3);
        wrongToken.mint(depositAddress, amount);
        wrongFunded += amount;
    }

    function fundNative(uint96 seed) public {
        uint256 amount = bound(seed, 1, 1 ether);
        vm.deal(depositAddress, depositAddress.balance + amount);
        nativeFunded += amount;
    }

    function deploy() public {
        vm.prank(attacker);
        assertEq(address(_deploy()), depositAddress);
    }

    function relay(bool viaFactory, uint8 modeSeed) public {
        if (!viaFactory) _deploy();
        uint256 balance = token.balanceOf(depositAddress);
        if (consumed || balance < quote) {
            vm.expectRevert(consumed ? _replayError() : _insufficientError());
            vm.prank(relayer);
            _relay(viaFactory);
            return;
        }

        TestPool.Mode mode = TestPool.Mode(uint256(modeSeed) % 4);
        pool.configure(mode);
        if (mode == TestPool.Mode.Reject || mode == TestPool.Mode.Partial) {
            bool deployed = depositAddress.code.length != 0;
            vm.expectRevert(mode == TestPool.Mode.Reject ? TestPool.PoolRejected.selector : _poolBalanceError());
            vm.prank(relayer);
            _relay(viaFactory);
            assertEq(depositAddress.code.length != 0, deployed);
        } else {
            uint256 amount = _consumed(balance);
            uint256 fees = amount / 1_000 + gasCharge;
            vm.prank(relayer);
            _relay(viaFactory);
            consumed = true;
            settlements++;
            feePaid += fees;
            poolPaid += amount - fees;
            assertEq(pool.lastCallHash(), _expectedCallHash(amount));
            if (mode == TestPool.Mode.Reenter) assertTrue(pool.reentryBlocked());
        }
        pool.configure(TestPool.Mode.Normal);
    }

    function recoverToken(bool wrong) public {
        DepositBase forwarder = _deploy();
        if (wrong) {
            uint256 amount = wrongToken.balanceOf(depositAddress);
            vm.prank(recovery);
            forwarder.recover(wrongToken);
            wrongRecovered += amount;
        } else {
            uint256 amount = token.balanceOf(depositAddress);
            vm.prank(recovery);
            forwarder.recover(token);
            recovered += amount;
        }
    }

    function recoverNative() public {
        DepositBase forwarder = _deploy();
        uint256 amount = depositAddress.balance;
        vm.prank(recovery);
        forwarder.recoverNative();
        nativeRecovered += amount;
    }

    function unauthorized(bool viaFactory, bool feeWallet) public {
        DepositBase forwarder = _deploy();
        address caller = feeWallet ? feeRecipient : attacker;
        vm.expectRevert(); // RAILGUN checks spent before authorization; PP checks it afterwards.
        vm.prank(caller);
        _relay(viaFactory);
        vm.expectRevert(DepositBase.NotRecoveryOwner.selector);
        vm.prank(caller);
        forwarder.recover(token);
        vm.expectRevert(DepositBase.NotRecoveryOwner.selector);
        vm.prank(caller);
        forwarder.recoverNative();
    }

    function assertAccounting() public view {
        assertEq(token.balanceOf(depositAddress) + recovered + feePaid + poolPaid, funded);
        assertEq(token.balanceOf(recovery), recovered);
        assertEq(token.balanceOf(feeRecipient), feePaid);
        assertEq(token.balanceOf(address(pool)), poolPaid);
        assertEq(token.balanceOf(attacker), 0);
        assertEq(token.balanceOf(relayer), 0);
        assertEq(wrongToken.balanceOf(depositAddress) + wrongRecovered, wrongFunded);
        assertEq(wrongToken.balanceOf(recovery), wrongRecovered);
        assertEq(depositAddress.balance + nativeRecovered, nativeFunded);
        assertEq(recovery.balance, nativeRecovered);
        assertEq(token.allowance(depositAddress, address(pool)), 0);
        assertLe(settlements, 1);
        assertEq(pool.calls(), settlements);
        if (depositAddress.code.length != 0) {
            _assertBindings();
            assertEq(DepositBase(depositAddress).spent(), consumed);
        } else {
            assertFalse(consumed);
        }
    }

    function assertEmpty() public view {
        assertEq(token.balanceOf(depositAddress), 0);
        assertEq(wrongToken.balanceOf(depositAddress), 0);
        assertEq(depositAddress.balance, 0);
    }
}

abstract contract DepositInvariantTest is Test {
    DepositHandler internal handler;
    function _createHandler() internal virtual returns (DepositHandler);

    function setUp() public {
        handler = _createHandler();
        handler.fund(500_000); // Start below the quote; random top-ups or recovery follow.
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = handler.fund.selector;
        selectors[1] = handler.fundWrongToken.selector;
        selectors[2] = handler.fundNative.selector;
        selectors[3] = handler.deploy.selector;
        selectors[4] = handler.relay.selector;
        selectors[5] = handler.recoverToken.selector;
        selectors[6] = handler.recoverNative.selector;
        selectors[7] = handler.unauthorized.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    function invariant_FundsPermissionsAndSingleUse() public view {
        handler.assertAccounting();
    }

    function afterInvariant() public {
        // Every generated history must end with all remaining funds recoverable.
        handler.recoverToken(false);
        handler.recoverToken(true);
        handler.recoverNative();
        handler.assertAccounting();
        handler.assertEmpty();
    }

    function test_HandlerExercisesFailuresSettlementAndLateRecovery() public {
        handler.relay(true, 0); // Underfunded rejection.
        handler.fund(1_000_000);
        handler.relay(true, 1); // Pool rejection.
        handler.relay(true, 2); // Incomplete pool consumption.
        handler.relay(false, 3); // Successful relay with blocked reentry.
        assertEq(handler.settlements(), 1);
        handler.fund(123);
        handler.fundWrongToken(456);
        handler.fundNative(789);
        handler.relay(true, 0); // Replay rejection, including after late funding.
        handler.unauthorized(true, false);
        handler.unauthorized(false, true);
        afterInvariant();
    }
}
