// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import {DepositFixture, TestToken, TestPool, DepositBase, DepositQuote, UnauthorizedRelayer} from "./DepositFixture.sol";
import {RecoveryReceiver, IRecoverableDeposit} from "fixtures/RecoveryReceiver.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {DepositConfig} from "contracts/DepositBase.sol";

// The identical settlement and recovery suite runs against both protocol adapters.
abstract contract DepositBehavior is DepositFixture {
    function setUp() public virtual {
        _initialize(1_000_000, 1_000);
    }

    function test_CloneHasFixedImplementationAndCannotBeReinitialized() public {
        DepositBase template = DepositBase(factory.implementation());
        vm.expectRevert("Initializable: contract is already initialized");
        vm.prank(factoryAddress);
        template.initialize(config);

        vm.prank(attacker); // Anyone can deploy, but nobody can change the bound terms.
        DepositBase forwarder = _deploy();
        assertEq(address(forwarder).code, abi.encodePacked(
            hex"363d3d373d3d3d363d73", address(template), hex"5af43d82803e903d91602b57fd5bf3"
        ));
        assertEq(address(forwarder).code.length, 45);
        _assertBindings();
        assertEq(forwarder.pool(), address(pool));
        assertEq(address(_deploy()), depositAddress);

        config.recovery = attacker;
        vm.expectRevert("Initializable: contract is already initialized");
        vm.prank(factoryAddress);
        forwarder.initialize(config);
        assertEq(forwarder.recovery(), recovery);
    }

    function test_OnlyFactoryCanInitializeEvenAnUninitializedClone() public {
        DepositBase clone = DepositBase(Clones.clone(factory.implementation()));
        vm.expectRevert(DepositBase.NotFactory.selector);
        vm.prank(attacker);
        clone.initialize(config);
        assertEq(clone.recovery(), address(0));
    }

    function test_ClonesKeepBalancesAndExecutionStateSeparate() public {
        DepositBase first = _deploy();
        DepositConfig memory other = config;
        other.recovery = attacker;
        DepositBase second = factory.deploy(salt, other);
        assertNotEq(address(first), address(second));
        token.mint(address(first), quote);
        token.mint(address(second), quote);
        vm.prank(relayer);
        _relay(true);
        assertTrue(first.spent());
        assertFalse(second.spent());
        assertEq(second.recovery(), attacker);
        assertEq(token.balanceOf(address(second)), quote);
        assertFalse(DepositBase(factory.implementation()).spent());
        vm.prank(attacker);
        second.recover(token);
        assertEq(token.balanceOf(attacker), quote);
    }

    function test_RepeatedRecoveryDoesNotCancelAnUnspentDeposit() public {
        DepositBase forwarder = _deploy();
        for (uint256 i; i < 2; ++i) {
            token.mint(depositAddress, quote);
            vm.prank(recovery);
            forwarder.recover(token);
            assertEq(token.balanceOf(recovery), quote * (i + 1));
            assertFalse(forwarder.spent());
            vm.expectRevert(_insufficientError());
            vm.prank(relayer);
            _relay(false);
        }
        token.mint(depositAddress, quote);
        vm.prank(relayer);
        _relay(true);
        assertTrue(forwarder.spent());
        assertEq(pool.calls(), 1);
    }

    function test_ExpiredQuoteCannotDeployOrPayFees() public {
        token.mint(depositAddress, quote);
        vm.warp(100);
        vm.expectRevert(DepositBase.QuoteExpired.selector);
        vm.prank(relayer);
        factory.deployAndExecute(salt, config, DepositQuote(token, quote, gasCharge, 99), _protocolData());
        assertEq(depositAddress.code.length, 0);
        assertEq(token.balanceOf(depositAddress), quote);
        assertEq(token.balanceOf(feeRecipient), 0);
    }

    function testFuzz_QuoteAboveCapCannotPayFees(uint256 seed) public {
        uint256 fee = bound(seed, gasCharge + 1, type(uint256).max);
        token.mint(depositAddress, quote);
        vm.expectRevert(DepositBase.GasFeeTooHigh.selector);
        vm.prank(relayer);
        factory.deployAndExecute(salt, config, _execution(fee), _protocolData());
        assertEq(depositAddress.code.length, 0);
        assertEq(token.balanceOf(depositAddress), quote);
        assertEq(token.balanceOf(feeRecipient), 0);
    }

    function testFuzz_SettlementConservesFunds(uint96 amountSeed, uint96 extra, uint96 gasSeed, bool viaFactory)
        public
    {
        uint256 amount = bound(amountSeed, 1_000, type(uint96).max);
        uint256 fee = bound(gasSeed, 0, amount - amount / 1_000 - 1);
        _initialize(amount, fee);
        uint256 funded = amount + uint256(extra);
        uint256 consumed = _consumed(funded);
        token.mint(depositAddress, funded);
        if (!viaFactory) {
            vm.prank(attacker);
            _deploy();
        }
        vm.prank(relayer);
        _relay(viaFactory);

        assertEq(token.balanceOf(depositAddress), funded - consumed);
        assertEq(token.balanceOf(feeRecipient), consumed / 1_000 + fee);
        assertEq(token.balanceOf(address(pool)), consumed - consumed / 1_000 - fee);
        assertEq(pool.lastCallHash(), _expectedCallHash(consumed));
        assertEq(token.allowance(depositAddress, address(pool)), 0);
        assertEq(pool.calls(), 1);
        assertTrue(DepositBase(depositAddress).spent());
        _assertBindings();

        vm.prank(recovery);
        DepositBase(depositAddress).recover(token);
        assertEq(token.balanceOf(recovery), funded - consumed);
    }

    function testFuzz_OnlyRelayerCanExecute(address caller, bool viaFactory) public {
        vm.assume(caller != relayer && caller != factoryAddress);
        token.mint(depositAddress, quote);
        _deploy();
        vm.expectRevert(UnauthorizedRelayer.selector);
        vm.prank(caller);
        _relay(viaFactory);
        assertEq(token.balanceOf(depositAddress), quote);
        assertEq(token.balanceOf(feeRecipient), 0);
        assertFalse(DepositBase(depositAddress).spent());
    }

    function testFuzz_OnlyOwnerCanRecover(address caller, uint96 amount) public {
        vm.assume(caller != recovery);
        token.mint(depositAddress, amount);
        vm.deal(depositAddress, amount);
        DepositBase forwarder = _deploy();
        vm.expectRevert(DepositBase.NotRecoveryOwner.selector);
        vm.prank(caller);
        forwarder.recover(token);
        vm.expectRevert(DepositBase.NotRecoveryOwner.selector);
        vm.prank(caller);
        forwarder.recoverNative();
        assertEq(token.balanceOf(depositAddress), amount);
        assertEq(depositAddress.balance, amount);
    }

    function testFuzz_OwnerRecoversUndeployedAndWrongTokenFunds(uint96 amount, uint96 other, uint96 nativeAmount)
        public
    {
        token.mint(depositAddress, amount);
        wrongToken.mint(depositAddress, other);
        vm.deal(depositAddress, nativeAmount); // Native balance received before CREATE2 deployment.
        assertEq(depositAddress.code.length, 0);
        vm.startPrank(recovery);
        DepositBase forwarder = _deploy();
        forwarder.recover(token);
        forwarder.recover(wrongToken);
        forwarder.recoverNative();
        vm.stopPrank();
        assertEq(token.balanceOf(recovery), amount);
        assertEq(wrongToken.balanceOf(recovery), other);
        assertEq(recovery.balance, nativeAmount);
        assertEq(token.balanceOf(feeRecipient), 0);
        assertEq(token.balanceOf(depositAddress), 0);
        assertEq(depositAddress.balance, 0);
        assertFalse(forwarder.spent());
    }

    function testFuzz_PartialFundingCanBeToppedUp(uint256 seed) public {
        uint256 initialAmount = bound(seed, 0, quote - 1);
        token.mint(depositAddress, initialAmount);
        vm.expectRevert(_insufficientError());
        vm.prank(relayer);
        _relay(true);
        assertEq(depositAddress.code.length, 0);
        assertEq(token.balanceOf(depositAddress), initialAmount);
        token.mint(depositAddress, quote - initialAmount);
        vm.prank(relayer);
        _relay(true);
        assertTrue(DepositBase(depositAddress).spent());
    }

    function testFuzz_ReplayAndLateTransfers(uint96 late, bool viaFactory) public {
        token.mint(depositAddress, quote);
        vm.prank(relayer);
        _relay(true);
        token.mint(depositAddress, late);
        assertEq(address(_deploy()), depositAddress); // Idempotent deployment must not reset spent.
        vm.expectRevert(_replayError());
        vm.prank(relayer);
        _relay(viaFactory);
        assertEq(pool.calls(), 1);
        assertEq(token.balanceOf(feeRecipient), quote / 1_000 + gasCharge);
        vm.prank(recovery);
        DepositBase(depositAddress).recover(token);
        assertEq(token.balanceOf(recovery), late);
    }

    function testFuzz_PoolFailureRollsBackEverything(bool predeploy, bool partialConsumption) public {
        token.mint(depositAddress, quote);
        if (predeploy) _deploy();
        pool.configure(partialConsumption ? TestPool.Mode.Partial : TestPool.Mode.Reject);
        vm.expectRevert(partialConsumption ? _poolBalanceError() : TestPool.PoolRejected.selector);
        vm.prank(relayer);
        _relay(true);
        assertEq(token.balanceOf(depositAddress), quote);
        assertEq(token.balanceOf(feeRecipient), 0);
        assertEq(token.balanceOf(address(pool)), 0);
        assertEq(token.allowance(depositAddress, address(pool)), 0);
        assertEq(pool.calls(), 0);
        if (predeploy) assertFalse(DepositBase(depositAddress).spent());
        else assertEq(depositAddress.code.length, 0);
        // A rejected deposit remains recoverable without fixing the pool or relayer.
        _deploy();
        vm.prank(recovery);
        DepositBase(depositAddress).recover(token);
        assertEq(token.balanceOf(recovery), quote);
    }

    function testFuzz_BadFeeTokenRollsBackEverything(bool tax) public {
        token.mint(depositAddress, quote);
        token.configure(tax ? TestToken.Mode.Tax : TestToken.Mode.ReturnFalse, address(0), "");
        vm.expectRevert(); // SafeERC20 rejects the failed or short fee transfer.
        vm.prank(relayer);
        _relay(true);
        assertEq(depositAddress.code.length, 0);
        assertEq(token.balanceOf(depositAddress), quote);
        assertEq(token.balanceOf(feeRecipient), 0);
        assertEq(token.balanceOf(address(pool)), 0);
        assertEq(pool.calls(), 0);
        assertEq(token.allowance(depositAddress, address(pool)), 0);
    }

    function test_NoReturnTokenCanSettle() public {
        token.mint(depositAddress, quote);
        token.configure(TestToken.Mode.NoReturn, address(0), "");
        vm.prank(relayer);
        _relay(true);
        assertTrue(DepositBase(depositAddress).spent());
        assertEq(token.balanceOf(feeRecipient), quote / 1_000 + gasCharge);
    }

    function test_CallbacksCannotReenter() public {
        token.mint(depositAddress, quote);
        token.configure(TestToken.Mode.Reenter, depositAddress, _relayData());
        pool.configure(TestPool.Mode.Reenter);
        vm.prank(relayer);
        _relay(true);
        assertTrue(token.reentryBlocked());
        assertTrue(pool.reentryBlocked());
        assertEq(pool.calls(), 1);
        assertEq(token.balanceOf(feeRecipient), quote / 1_000 + gasCharge);
    }

    function test_NativeRecoveryRejectsReentryAndPreservesRejectedPayments() public {
        RecoveryReceiver receiver = new RecoveryReceiver();
        // Rebuild protocol terms with this contract as recovery owner.
        recovery = address(receiver);
        _setUpProtocol();
        depositAddress = _predict();
        DepositBase forwarder = _deploy();
        vm.deal(depositAddress, 1 ether);
        receiver.configure(IRecoverableDeposit(depositAddress), true);
        vm.expectRevert();
        receiver.recoverNative();
        assertEq(depositAddress.balance, 1 ether);
        receiver.configure(IRecoverableDeposit(depositAddress), false);
        receiver.recoverNative();
        assertTrue(receiver.reentryBlocked());
        assertEq(depositAddress.balance, 0);
        assertEq(address(receiver).balance, 1 ether);
        assertFalse(forwarder.spent());
    }
}
