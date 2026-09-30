// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ShieldRequest, ShieldCiphertext, CommitmentPreimage, TokenData, TokenType}
    from "railgun/contracts/logic/Globals.sol";

interface IRailgun {
    function shield(ShieldRequest[] calldata requests) external;
}

/// @dev Amounts are in the deposit token's smallest units, never USD or native gas units.
struct DepositConfig {
    IERC20 token;
    bytes32 notePublicKey;
    ShieldCiphertext ciphertext;
    address recovery; // Sole authority to withdraw unshielded funds.
    address relayer; // Sole authority to trigger shielding and choose the gas charge.
    address feeRecipient; // Receives the service fee and gas charge.
    uint256 minDeposit; // Minimum balance required to consume this one-shot address.
    uint256 maxGasFee; // Upper bound on the relayer's charge, not a gas-cost measurement.
}

error UnauthorizedRelayer();
error InvalidConfiguration();

uint256 constant SERVICE_FEE_DIVISOR = 1_000;

// Shared by address calculation and deployment: invalid terms must fail before anyone funds an address.
function _validateConfig(IRailgun pool, DepositConfig memory config) view {
    if (
        address(pool).code.length == 0 || address(config.token).code.length == 0
            || config.recovery == address(0) || config.relayer == address(0)
            || config.feeRecipient == address(0)
            || config.minDeposit == 0 || config.minDeposit > type(uint120).max
    ) revert InvalidConfiguration();
    // The smallest permitted deposit must leave funds to shield even at the maximum fee.
    if (config.maxGasFee >= config.minDeposit - config.minDeposit / SERVICE_FEE_DIVISOR) {
        revert InvalidConfiguration();
    }
}

/// @notice One deposit, one token, one fixed RAILGUN recipient. Unaudited.
contract DepositForwarder is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant SERVICE_FEE_BPS = 10_000 / SERVICE_FEE_DIVISOR; // 0.1%, rounded down.

    address public immutable factory;
    IRailgun public immutable railgun;
    IERC20 public immutable token;
    bytes32 public immutable notePublicKey;
    address public immutable recovery;
    address public immutable relayer;
    address public immutable feeRecipient;
    uint256 public immutable minDeposit;
    uint256 public immutable maxGasFee;
    ShieldCiphertext private ciphertext;
    bool public spent;

    error AlreadyShielded();
    error InvalidBalance();
    error GasFeeTooHigh();
    error NotRecoveryOwner();
    error UnsupportedToken();
    error IncompleteShield();

    event Shielded(uint256 depositAmount, uint256 serviceFee, uint256 gasFee, uint256 shieldAmount);
    event Recovered(address indexed asset, uint256 amount);

    constructor(IRailgun pool, DepositConfig memory config) {
        _validateConfig(pool, config);
        if (config.recovery == address(this) || config.feeRecipient == address(this)) {
            revert InvalidConfiguration();
        }
        factory = msg.sender;
        railgun = pool;
        token = config.token;
        notePublicKey = config.notePublicKey;
        ciphertext = config.ciphertext;
        recovery = config.recovery;
        relayer = config.relayer;
        feeRecipient = config.feeRecipient;
        minDeposit = config.minDeposit;
        maxGasFee = config.maxGasFee;
    }

    /// @notice Validate amount and fee; return the service fee and gross amount sent to RAILGUN.
    /// @dev RAILGUN deducts its own protocol fee from shieldAmount.
    function preview(uint256 amount, uint256 gasFee)
        public view returns (uint256 serviceFee, uint256 shieldAmount)
    {
        if (amount < minDeposit || amount > type(uint120).max) revert InvalidBalance();
        if (gasFee > maxGasFee) revert GasFeeTooHigh();
        serviceFee = amount / SERVICE_FEE_DIVISOR;
        shieldAmount = amount - serviceFee - gasFee;
    }

    /// @notice Only the fixed relayer can shield, including with a zero gas charge.
    /// @dev The immutable factory checks the original caller before forwarding a request.
    /// Fees go to the fixed feeRecipient, never msg.sender. A revert rolls back all token payments.
    function shield(uint256 gasFee) external nonReentrant {
        if (spent) revert AlreadyShielded();
        if (msg.sender != relayer && msg.sender != factory) {
            revert UnauthorizedRelayer();
        }
        uint256 amount = token.balanceOf(address(this));
        (uint256 serviceFee, uint256 shieldAmount) = preview(amount, gasFee);
        spent = true;

        uint256 totalFee = serviceFee + gasFee;
        if (totalFee != 0) {
            uint256 recipientBefore = token.balanceOf(feeRecipient);
            token.safeTransfer(feeRecipient, totalFee);
            if (token.balanceOf(feeRecipient) != recipientBefore + totalFee) revert UnsupportedToken();
        }
        if (token.balanceOf(address(this)) != shieldAmount) revert UnsupportedToken();

        ShieldRequest[] memory requests = new ShieldRequest[](1);
        requests[0] = ShieldRequest({
            preimage: CommitmentPreimage({
                npk: notePublicKey,
                token: TokenData(TokenType.ERC20, address(token), 0),
                value: uint120(shieldAmount)
            }),
            ciphertext: ciphertext
        });
        token.safeApprove(address(railgun), shieldAmount);
        railgun.shield(requests);
        token.safeApprove(address(railgun), 0);
        if (token.balanceOf(address(this)) != 0) revert IncompleteShield();
        emit Shielded(amount, serviceFee, gasFee, shieldAmount);
    }

    /// @notice Recover unshielded or late-arriving tokens to the fixed recovery owner, without fees.
    function recover(IERC20 asset) external nonReentrant {
        if (msg.sender != recovery) revert NotRecoveryOwner();
        uint256 amount = asset.balanceOf(address(this));
        asset.safeTransfer(recovery, amount);
        emit Recovered(address(asset), amount);
    }

    /// @notice Recover native currency accidentally sent before deployment or forcibly received.
    function recoverNative() external nonReentrant {
        if (msg.sender != recovery) revert NotRecoveryOwner();
        uint256 amount = address(this).balance;
        Address.sendValue(payable(recovery), amount);
        emit Recovered(address(0), amount);
    }
}

/// @notice Immutable, permissionless CREATE2 deployment. No owner, upgrades, or withdrawal authority.
contract DepositFactory {
    IRailgun public immutable railgun;

    error InvalidPool();

    event Deployed(address indexed deposit, address indexed token, bytes32 indexed salt);

    constructor(IRailgun pool) {
        if (address(pool).code.length == 0) revert InvalidPool();
        railgun = pool;
    }

    /// @notice Predict a deposit address after validating its fixed terms.
    function computeAddress(bytes32 salt, DepositConfig calldata config) public view returns (address) {
        _validateConfig(railgun, config);
        bytes32 codeHash = keccak256(abi.encodePacked(
            type(DepositForwarder).creationCode, abi.encode(railgun, config)
        ));
        address predicted = Create2.computeAddress(salt, codeHash);
        if (config.recovery == predicted || config.feeRecipient == predicted) revert InvalidConfiguration();
        return predicted;
    }

    /// @notice Anyone can deploy; repeated calls return the existing forwarder without changing it.
    function deploy(bytes32 salt, DepositConfig calldata config) public returns (DepositForwarder forwarder) {
        address predicted = computeAddress(salt, config);
        if (predicted.code.length != 0) return DepositForwarder(predicted);
        forwarder = new DepositForwarder{salt: salt}(railgun, config);
        emit Deployed(address(forwarder), address(config.token), salt);
    }

    /// @notice Deploy and shield in one transaction, with the same caller rules as shield.
    function deployAndShield(bytes32 salt, DepositConfig calldata config, uint256 gasFee)
        external returns (address)
    {
        // Never let a caller borrow the factory's authority to bypass the fixed relayer.
        if (msg.sender != config.relayer) revert UnauthorizedRelayer();
        DepositForwarder forwarder = deploy(salt, config);
        forwarder.shield(gasFee);
        return address(forwarder);
    }
}
