// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {DepositBehavior} from "../shared/DepositBehavior.sol";
import {PrivacyPoolsFixture, PrivacyPoolsDepositFactory, PrivacyPoolsStub, DepositBase, DepositConfig, DepositQuote, TokenPolicy}
    from "./Fixture.sol";
import {InvalidConfiguration} from "../../../contracts/DepositBase.sol";

contract PrivacyPoolsDepositTest is DepositBehavior, PrivacyPoolsFixture {
    function testFuzz_AnyCalldataChangeIsRejected(uint256 indexSeed, bytes1 changeSeed, bool viaFactory) public {
        bytes memory changed = callData;
        uint256 index = bound(indexSeed, 0, changed.length - 1);
        changed[index] ^= changeSeed | bytes1(0x01);
        token.mint(depositAddress, quote);
        if (!viaFactory) _deploy();
        vm.expectRevert(DepositBase.WrongDepositCall.selector);
        vm.prank(relayer);
        if (viaFactory) factory.deployAndExecute(salt, config, _execution(gasCharge), changed);
        else DepositBase(depositAddress).execute(_execution(gasCharge), changed);
        assertEq(token.balanceOf(depositAddress), quote);
        assertEq(token.balanceOf(feeRecipient), 0);
        assertEq(pool.calls(), 0);
    }

    function testFuzz_CommittedNonDepositSelectorIsRejected(bytes4 selector, uint8 lengthSeed) public {
        vm.assume(selector != PrivacyPoolsStub.deposit.selector);
        bytes memory data = abi.encodePacked(selector);
        uint256 length = uint256(lengthSeed) % 5;
        assembly { mstore(data, length) }
        config.recipient = abi.encode(keccak256(data));
        depositAddress = _predict();
        token.mint(depositAddress, quote);
        vm.expectRevert(DepositBase.WrongDepositCall.selector);
        vm.prank(relayer);
        factory.deployAndExecute(salt, config, _execution(gasCharge), data);
        assertEq(depositAddress.code.length, 0);
    }

    function testFuzz_Create2BindsEveryTerm(bytes32 entropy, uint8 fieldSeed) public view {
        DepositConfig memory changed = config;
        uint256 field = uint256(fieldSeed) % 5;
        bytes32 newSalt = salt;
        if (field == 0) changed.recipient = abi.encode(keccak256(abi.encode(entropy)));
        else if (field == 1) changed.recovery = attacker;
        else if (field == 2) changed.relayer = attacker;
        else if (field == 3) changed.feeRecipient = attacker;
        else newSalt ^= bytes32(uint256(entropy) | 1);
        assertNotEq(factory.computeAddress(newSalt, changed), depositAddress);
    }

    function testFuzz_InvalidTermsRejectedBeforeFunding(uint8 fieldSeed) public {
        uint256 field = uint256(fieldSeed) % 5;
        if (field == 0) config.recipient = hex"12";
        else if (field == 1) config.recipient = abi.encode(bytes32(0));
        else if (field == 2) config.recovery = address(0);
        else if (field == 3) config.relayer = address(0);
        else config.feeRecipient = address(0);
        vm.expectRevert(InvalidConfiguration.selector);
        factory.computeAddress(salt, config);
        vm.expectRevert(InvalidConfiguration.selector);
        factory.deploy(salt, config);
    }

    function test_NewGasQuotePreservesAddressAndPrivateDeposit() public {
        uint256 cost = quote - quote / 1_000 - gasCharge;
        uint256 fee = gasCharge / 2;
        uint256 amount = (cost + fee) * 1_000 / 999;
        token.mint(depositAddress, amount);
        vm.prank(relayer);
        factory.deployAndExecute(salt, config, DepositQuote(token, amount, fee, block.timestamp), callData);
        assertEq(token.balanceOf(address(pool)), cost);
        assertEq(token.balanceOf(feeRecipient), amount / 1_000 + fee);
        assertEq(factory.computeAddress(salt, config), depositAddress);
    }

    function test_WrongNetAmountRollsBackAllFeesAndDeployment() public {
        token.mint(depositAddress, quote);
        vm.expectRevert(DepositBase.IncompleteDeposit.selector);
        vm.prank(relayer);
        factory.deployAndExecute(salt, config, _execution(0), callData);
        assertEq(depositAddress.code.length, 0);
        assertEq(token.balanceOf(feeRecipient), 0);
        assertEq(token.balanceOf(depositAddress), quote);
    }

    function test_SupportedWrongTokenCannotSpendAnotherAsset() public {
        TokenPolicy[] memory policies = new TokenPolicy[](2);
        policies[0] = TokenPolicy(token, uint120(gasCharge), 0);
        policies[1] = TokenPolicy(wrongToken, uint120(gasCharge), 0);
        factory = new PrivacyPoolsDepositFactory(address(pool), policies);
        depositAddress = _predict();
        token.mint(depositAddress, quote);
        wrongToken.mint(depositAddress, quote);
        vm.expectRevert(); // The committed call needs the original token, which was never approved.
        vm.prank(relayer);
        factory.deployAndExecute(salt, config,
            DepositQuote(wrongToken, quote, gasCharge, block.timestamp), callData);
        assertEq(depositAddress.code.length, 0);
        assertEq(token.balanceOf(depositAddress), quote);
        assertEq(wrongToken.balanceOf(depositAddress), quote);
        assertEq(wrongToken.balanceOf(feeRecipient), 0);
        assertEq(token.balanceOf(address(pool)), 0);
    }
}
