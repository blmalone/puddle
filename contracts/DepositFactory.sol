// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ShieldRequest, ShieldCiphertext, CommitmentPreimage, TokenData, TokenType}
    from "railgun/contracts/logic/Globals.sol";

interface IRailgun {
    function shield(ShieldRequest[] calldata requests) external;
}

/// @notice Local demonstration only. One note, one token, one shielding call.
contract DepositForwarder is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IRailgun public immutable railgun;
    IERC20 public immutable token;
    bytes32 public immutable notePublicKey;
    address public immutable recovery;
    ShieldCiphertext private ciphertext;
    bool public spent;

    error AlreadyShielded();
    error InvalidBalance();
    error NotRecoveryOwner();

    constructor(
        IRailgun pool,
        IERC20 asset,
        bytes32 npk,
        ShieldCiphertext memory encryptedNote,
        address recoveryOwner
    ) {
        require(address(pool).code.length != 0 && address(asset).code.length != 0, "Missing contract");
        require(recoveryOwner != address(0), "Missing recovery owner");
        railgun = pool;
        token = asset;
        notePublicKey = npk;
        ciphertext = encryptedNote;
        recovery = recoveryOwner;
    }

    /// @notice Anyone can pay gas, but nobody can choose a new recipient or token.
    function shield() external nonReentrant {
        if (spent) revert AlreadyShielded();
        uint256 amount = token.balanceOf(address(this));
        if (amount == 0 || amount > type(uint120).max) revert InvalidBalance();
        spent = true;

        ShieldRequest[] memory requests = new ShieldRequest[](1);
        requests[0] = ShieldRequest({
            preimage: CommitmentPreimage({
                npk: notePublicKey,
                token: TokenData(TokenType.ERC20, address(token), 0),
                value: uint120(amount)
            }),
            ciphertext: ciphertext
        });
        token.safeApprove(address(railgun), amount);
        railgun.shield(requests);
        token.safeApprove(address(railgun), 0);
    }

    /// @notice Public recovery of unshielded or late-arriving tokens to a fixed owner.
    /// @dev This does not withdraw anything already inside RAILGUN.
    function recover(IERC20 asset) external nonReentrant {
        if (msg.sender != recovery) revert NotRecoveryOwner();
        asset.safeTransfer(recovery, asset.balanceOf(address(this)));
    }
}

contract DepositFactory {
    IRailgun public immutable railgun;

    constructor(IRailgun pool) { railgun = pool; }

    function computeAddress(
        bytes32 salt, IERC20 token, bytes32 npk,
        ShieldCiphertext calldata ciphertext, address recovery
    ) public view returns (address) {
        bytes32 codeHash = keccak256(abi.encodePacked(
            type(DepositForwarder).creationCode,
            abi.encode(railgun, token, npk, ciphertext, recovery)
        ));
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff), address(this), salt, codeHash
        )))));
    }

    function deploy(
        bytes32 salt, IERC20 token, bytes32 npk,
        ShieldCiphertext calldata ciphertext, address recovery
    ) public returns (DepositForwarder forwarder) {
        address predicted = computeAddress(salt, token, npk, ciphertext, recovery);
        if (predicted.code.length != 0) return DepositForwarder(predicted);
        return new DepositForwarder{salt: salt}(railgun, token, npk, ciphertext, recovery);
    }

    function deployAndShield(
        bytes32 salt, IERC20 token, bytes32 npk,
        ShieldCiphertext calldata ciphertext, address recovery
    ) external returns (address) {
        DepositForwarder forwarder = deploy(salt, token, npk, ciphertext, recovery);
        forwarder.shield();
        return address(forwarder);
    }
}
