// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {DepositBase, DepositConfig, IERC20, InvalidConfiguration} from "../DepositBase.sol";
import {DepositFactory, TokenPolicy} from "../DepositFactory.sol";
import {ShieldRequest, ShieldCiphertext, CommitmentPreimage, TokenData, TokenType}
    from "railgun/contracts/logic/Globals.sol";

interface IRailgun {
    function shield(ShieldRequest[] calldata requests) external;
}

function validateRailgunRecipient(bytes memory recipient) pure {
    // abi.encode(bytes32 notePublicKey, ShieldCiphertext ciphertext): five fixed words.
    if (recipient.length != 160) revert InvalidConfiguration();
}

contract RailgunDeposit is DepositBase {
    bytes32 public immutable notePublicKey;
    ShieldCiphertext private ciphertext;

    constructor(address target, DepositConfig memory config) DepositBase(target, config) {
        validateRailgunRecipient(config.recipient);
        (notePublicKey, ciphertext) = abi.decode(config.recipient, (bytes32, ShieldCiphertext));
    }

    function _poolCall(IERC20 token, uint256 amount, bytes calldata data) internal view override returns (bytes memory) {
        if (data.length != 0) revert WrongDepositCall();
        ShieldRequest[] memory requests = new ShieldRequest[](1);
        requests[0] = ShieldRequest({
            preimage: CommitmentPreimage(notePublicKey, TokenData(TokenType.ERC20, address(token), 0), uint120(amount)),
            ciphertext: ciphertext
        });
        return abi.encodeCall(IRailgun.shield, (requests));
    }
}

contract RailgunDepositFactory is DepositFactory {
    constructor(address target, TokenPolicy[] memory policies) DepositFactory(target, policies) {}

    function _initCode(DepositConfig calldata config) internal view override returns (bytes memory) {
        validateRailgunRecipient(config.recipient);
        return abi.encodePacked(type(RailgunDeposit).creationCode, abi.encode(pool, config));
    }
}
