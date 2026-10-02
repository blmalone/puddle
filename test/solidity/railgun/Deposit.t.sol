// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {DepositBehavior} from "../shared/DepositBehavior.sol";
import {RailgunFixture, DepositFactory, RailgunDepositFactory, DepositBase, DepositConfig, IERC20, TokenPolicy, DepositQuote} from "./Fixture.sol";
import {InvalidConfiguration} from "../../../contracts/DepositBase.sol";

contract RailgunDepositTest is DepositBehavior, RailgunFixture {
    function testFuzz_GasCapAndMinimumLeavePositiveShield(uint120 amountSeed, uint256 gasSeed) public {
        uint256 amount = bound(amountSeed, 1, type(uint120).max);
        uint256 cap = bound(gasSeed, 0, amount - amount / 1_000 - 1);
        _initialize(amount, cap);
        DepositBase forwarder = DepositBase(address(_deploy()));
        (uint256 fee, uint256 shielded) = forwarder.preview(_execution(cap));
        assertEq(fee, amount / 1_000);
        assertEq(fee + cap + shielded, amount);
        assertGt(shielded, 0);
        vm.expectRevert(DepositBase.GasFeeTooHigh.selector);
        forwarder.preview(_execution(cap + 1));
    }

    function testFuzz_OverCapExecutionCannotPayFees(uint256 seed, bool viaFactory) public {
        uint256 fee = bound(seed, gasCharge + 1, type(uint256).max);
        token.mint(depositAddress, quote);
        _deploy();
        vm.expectRevert(DepositBase.GasFeeTooHigh.selector);
        vm.prank(relayer);
        if (viaFactory) factory.deployAndExecute(salt, config, _execution(fee), "");
        else DepositBase(depositAddress).execute(_execution(fee), "");
        assertEq(token.balanceOf(depositAddress), quote);
        assertEq(token.balanceOf(feeRecipient), 0);
        assertFalse(DepositBase(depositAddress).spent());
    }

    function testFuzz_ValidGasChargeCanBeLowerThanCap(uint256 seed) public {
        uint256 fee = bound(seed, 0, gasCharge);
        token.mint(depositAddress, quote);
        vm.prank(relayer);
        factory.deployAndExecute(salt, config, _execution(fee), "");
        assertEq(token.balanceOf(feeRecipient), quote / 1_000 + fee);
        assertEq(token.balanceOf(address(pool)), quote - quote / 1_000 - fee);
    }

    function testFuzz_OversizedBalanceStaysRecoverable(uint256 seed) public {
        uint256 amount = bound(seed, uint256(type(uint120).max) + 1, type(uint256).max);
        token.mint(depositAddress, amount);
        vm.expectRevert(DepositBase.InvalidBalance.selector);
        vm.prank(relayer);
        factory.deployAndExecute(salt, config, DepositQuote(token, amount, 0, type(uint256).max), "");
        _deploy();
        vm.prank(recovery);
        DepositBase(depositAddress).recover(token);
        assertEq(token.balanceOf(recovery), amount);
        assertEq(token.balanceOf(feeRecipient), 0);
    }

    function testFuzz_Create2BindsEveryTerm(bytes32 entropy, uint8 fieldSeed) public view {
        DepositConfig memory changed = config;
        uint256 field = uint256(fieldSeed) % 9;
        bytes32 newSalt = salt;
        if (field < 5) changed.recipient[field * 32] ^= bytes1(uint8(uint256(entropy)) | 1);
        else if (field == 5) changed.recovery = attacker;
        else if (field == 6) changed.relayer = attacker;
        else if (field == 7) changed.feeRecipient = attacker;
        else newSalt ^= bytes32(uint256(entropy) | 1);
        assertNotEq(factory.computeAddress(newSalt, changed), depositAddress);
    }

    function testFuzz_InvalidTermsRejectedBeforeFunding(uint8 fieldSeed) public {
        uint256 field = uint256(fieldSeed) % 3;
        if (field == 0) config.recovery = address(0);
        else if (field == 1) config.relayer = address(0);
        else config.feeRecipient = address(0);
        vm.expectRevert(InvalidConfiguration.selector);
        factory.computeAddress(salt, config);
        vm.expectRevert(InvalidConfiguration.selector);
        factory.deploy(salt, config);
    }

    function testFuzz_FixedPlusPercentageCap(uint120 amountSeed, uint120 fixedCap, uint16 bpsSeed) public {
        uint256 amount = bound(amountSeed, 1_000, type(uint120).max);
        uint16 bps = uint16(bound(bpsSeed, 0, 9_990));
        TokenPolicy[] memory policies = new TokenPolicy[](1);
        policies[0] = TokenPolicy(token, fixedCap, bps);
        DepositFactory f = new RailgunDepositFactory(address(pool), policies);
        uint256 cap = uint256(fixedCap) + amount * bps / 10_000;
        assertEq(f.maxGasFee(token, amount), cap);
        DepositBase deposit = f.deploy(salt, config);
        vm.expectRevert(DepositBase.GasFeeTooHigh.selector);
        deposit.preview(DepositQuote(token, amount, cap + 1, block.timestamp));
        uint256 affordable = amount - amount / 1_000 - 1;
        uint256 fee = cap < affordable ? cap : affordable;
        (uint256 serviceFee, uint256 shieldAmount) = deposit.preview(DepositQuote(token, amount, fee, block.timestamp));
        assertEq(serviceFee + shieldAmount + fee, amount);
        assertGt(shieldAmount, 0);
    }

    function test_RequoteChangesAmountWithoutChangingAddress() public {
        uint256 smaller = quote / 2;
        token.mint(depositAddress, smaller);
        vm.prank(relayer);
        factory.deployAndExecute(salt, config, DepositQuote(token, smaller, gasCharge, block.timestamp), "");
        assertEq(token.balanceOf(address(pool)), smaller - smaller / 1_000 - gasCharge);
        assertEq(factory.computeAddress(salt, config), depositAddress);
    }

    function test_ExpiredQuoteRollsBackAndOwnerCanRecover() public {
        token.mint(depositAddress, quote);
        vm.warp(100);
        vm.expectRevert(DepositBase.QuoteExpired.selector);
        vm.prank(relayer);
        factory.deployAndExecute(salt, config, DepositQuote(token, quote, gasCharge, 99), "");
        assertEq(depositAddress.code.length, 0);
        DepositBase deposit = DepositBase(address(_deploy()));
        vm.prank(recovery);
        deposit.recover(token);
        assertEq(token.balanceOf(recovery), quote);
        assertEq(token.balanceOf(feeRecipient), 0);
    }

    function test_UnsupportedTokenRejectedAndRecoverable() public {
        wrongToken.mint(depositAddress, quote);
        vm.expectRevert(DepositFactory.UnsupportedAsset.selector);
        vm.prank(relayer);
        factory.deployAndExecute(salt, config, DepositQuote(wrongToken, quote, 0, block.timestamp), "");
        DepositBase deposit = DepositBase(address(_deploy()));
        vm.prank(recovery);
        deposit.recover(wrongToken);
        assertEq(wrongToken.balanceOf(recovery), quote);
    }

    function testFuzz_RejectsInvalidPolicy(uint8 fieldSeed) public {
        TokenPolicy[] memory policies = new TokenPolicy[](2);
        policies[0] = TokenPolicy(token, 0, 0);
        policies[1] = TokenPolicy(wrongToken, 0, 0);
        uint256 field = uint256(fieldSeed) % 4;
        if (field == 0) policies[0].token = IERC20(address(0));
        else if (field == 1) policies[0].token = IERC20(attacker);
        else if (field == 2) policies[0].maxGasFeeBps = 9_991;
        else policies[1].token = token;
        vm.expectRevert(InvalidConfiguration.selector);
        new RailgunDepositFactory(address(pool), policies);
    }

    function test_RejectsPoolWithoutCode() public {
        TokenPolicy[] memory policies = new TokenPolicy[](1);
        policies[0] = TokenPolicy(token, 0, 0);
        vm.expectRevert(DepositFactory.InvalidPool.selector);
        new RailgunDepositFactory(attacker, policies);
    }
}
