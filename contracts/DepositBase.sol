// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

error InvalidConfiguration();
error UnauthorizedRelayer();

/// @dev Recipient instructions are interpreted only by the protocol adapter.
struct DepositConfig {
    bytes recipient;
    address recovery;
    address relayer;
    address feeRecipient;
}

struct DepositQuote {
    IERC20 token;
    uint256 amount;
    uint256 gasFee;
    uint256 deadline;
}

interface IFeePolicy {
    function maxGasFee(IERC20 token, uint256 amount) external view returns (uint256);
}

function validateParties(DepositConfig memory config) pure {
    if (config.recovery == address(0) || config.relayer == address(0) || config.feeRecipient == address(0)) {
        revert InvalidConfiguration();
    }
}

/// @notice Shared single-use settlement and owner-only recovery. Unaudited.
/// @dev ERC-1167 clones share fixed code and pool. Initialization adds no upgrade authority.
abstract contract DepositBase is ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    using Address for address;

    uint256 public constant SERVICE_FEE_BPS = 10; // 0.1%, rounded down.
    address public immutable factory;
    address public immutable pool;
    address public recovery;
    address public relayer;
    address public feeRecipient;
    bool public spent;

    error AlreadyExecuted();
    error InvalidBalance();
    error GasFeeTooHigh();
    error QuoteExpired();
    error UnsupportedToken();
    error IncompleteDeposit();
    error WrongDepositCall();
    error NotRecoveryOwner();
    error NotFactory();

    event Executed(address indexed token, uint256 amount, uint256 serviceFee, uint256 gasFee, uint256 poolAmount);
    event Recovered(address indexed asset, uint256 amount);

    constructor(address target) {
        if (target.code.length == 0) revert InvalidConfiguration();
        factory = msg.sender;
        pool = target;
        _disableInitializers();
    }

    /// @dev The factory creates and initializes each clone atomically. Terms cannot be reset.
    function initialize(DepositConfig calldata config) external initializer {
        if (msg.sender != factory) revert NotFactory();
        validateParties(config);
        if (config.recovery == address(this) || config.feeRecipient == address(this)) {
            revert InvalidConfiguration();
        }
        __ReentrancyGuard_init();
        recovery = config.recovery;
        relayer = config.relayer;
        feeRecipient = config.feeRecipient;
        _initializeRecipient(config.recipient);
    }

    function _initializeRecipient(bytes calldata recipient) internal virtual;

    /// @notice Pool fees, if any, are taken from poolAmount by the selected protocol.
    function preview(DepositQuote calldata quote) public view returns (uint256 serviceFee, uint256 poolAmount) {
        if (block.timestamp > quote.deadline) revert QuoteExpired();
        if (quote.amount == 0 || quote.amount > type(uint120).max) revert InvalidBalance();
        if (quote.gasFee > IFeePolicy(factory).maxGasFee(quote.token, quote.amount)) revert GasFeeTooHigh();
        serviceFee = quote.amount / 1_000;
        if (quote.gasFee >= quote.amount - serviceFee) revert InvalidBalance();
        poolAmount = quote.amount - serviceFee - quote.gasFee;
    }

    /// @notice Consume exactly the quote once. All transfers roll back if the pool call fails.
    /// @dev The factory checks the original caller. A transaction from the fixed relayer authorizes the quote.
    function execute(DepositQuote calldata quote, bytes calldata data) external nonReentrant {
        if (spent) revert AlreadyExecuted();
        if (msg.sender != relayer && msg.sender != factory) revert UnauthorizedRelayer();
        (uint256 serviceFee, uint256 poolAmount) = preview(quote);
        bytes memory callData = _poolCall(quote.token, poolAmount, data);
        IERC20 token = quote.token;
        uint256 beforeBalance = token.balanceOf(address(this));
        if (beforeBalance < quote.amount) revert InvalidBalance();
        spent = true;

        uint256 totalFee = serviceFee + quote.gasFee;
        if (totalFee != 0) {
            uint256 recipientBefore = token.balanceOf(feeRecipient);
            token.safeTransfer(feeRecipient, totalFee);
            if (token.balanceOf(feeRecipient) != recipientBefore + totalFee) revert UnsupportedToken();
        }
        if (token.balanceOf(address(this)) != beforeBalance - totalFee) revert UnsupportedToken();

        token.safeApprove(pool, poolAmount);
        pool.functionCall(callData);
        token.safeApprove(pool, 0);
        if (token.balanceOf(address(this)) != beforeBalance - quote.amount) revert IncompleteDeposit();
        emit Executed(address(token), quote.amount, serviceFee, quote.gasFee, poolAmount);
    }

    function _poolCall(IERC20 token, uint256 amount, bytes calldata data) internal view virtual returns (bytes memory);

    function recover(IERC20 asset) external nonReentrant {
        if (msg.sender != recovery) revert NotRecoveryOwner();
        uint256 amount = asset.balanceOf(address(this));
        asset.safeTransfer(recovery, amount);
        emit Recovered(address(asset), amount);
    }

    function recoverNative() external nonReentrant {
        if (msg.sender != recovery) revert NotRecoveryOwner();
        uint256 amount = address(this).balance;
        Address.sendValue(payable(recovery), amount);
        emit Recovered(address(0), amount);
    }
}
