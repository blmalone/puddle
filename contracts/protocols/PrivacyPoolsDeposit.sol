// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {DepositBase, DepositConfig, IERC20, InvalidConfiguration} from "../DepositBase.sol";
import {DepositFactory, TokenPolicy} from "../DepositFactory.sol";

function validatePrivacyPoolsRecipient(bytes memory recipient) pure {
    // The complete prepared deposit binds the proof, recipient, note data and screening payload.
    if (recipient.length != 32 || abi.decode(recipient, (bytes32)) == bytes32(0)) revert InvalidConfiguration();
}

/// @notice Puddle has no upgrade authority. The upstream Privacy Pools entrypoint remains upgradeable.
contract PrivacyPoolsDeposit is DepositBase {
    bytes4 public constant DEPOSIT_SELECTOR = bytes4(keccak256(
        "deposit((uint256[2],uint256[2][2],uint256[2],uint256[4]),(bytes32,bytes),bytes)"
    ));
    bytes32 public immutable callHash;

    constructor(address target, DepositConfig memory config) DepositBase(target, config) {
        validatePrivacyPoolsRecipient(config.recipient);
        callHash = abi.decode(config.recipient, (bytes32));
    }

    function _poolCall(IERC20, uint256, bytes calldata data) internal view override returns (bytes memory) {
        if (data.length < 4 || bytes4(data[:4]) != DEPOSIT_SELECTOR || keccak256(data) != callHash) {
            revert WrongDepositCall();
        }
        // The shared executor approves only the quoted token and checks the exact pool debit.
        // A quote for another token or a different net deposit therefore reverts atomically.
        return data;
    }
}

contract PrivacyPoolsDepositFactory is DepositFactory {
    constructor(address target, TokenPolicy[] memory policies) DepositFactory(target, policies) {}

    function _initCode(DepositConfig calldata config) internal view override returns (bytes memory) {
        validatePrivacyPoolsRecipient(config.recipient);
        return abi.encodePacked(type(PrivacyPoolsDeposit).creationCode, abi.encode(pool, config));
    }
}
