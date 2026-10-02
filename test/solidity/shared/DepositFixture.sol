// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DepositBase, DepositConfig, DepositQuote, UnauthorizedRelayer} from "contracts/DepositBase.sol";

import {DepositFactory} from "contracts/DepositFactory.sol";

// Test-only token and pool. Real proofs and recipient decryption remain covered
// by the TypeScript integration suites, not these deliberately permissive pools.
contract TestToken is ERC20 {
    enum Mode {
        Normal,
        ReturnFalse,
        Tax,
        NoReturn,
        Reenter
    }
    Mode public mode;
    address public callbackTarget;
    bytes public callbackData;
    bool public reentryBlocked;

    constructor() ERC20("Test token", "TEST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function configure(Mode next, address target, bytes memory data) external {
        mode = next;
        callbackTarget = target;
        callbackData = data;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (mode == Mode.ReturnFalse) return false;
        if (mode == Mode.Tax && amount != 0) {
            _burn(msg.sender, 1);
            return super.transfer(to, amount - 1);
        }
        if (mode == Mode.Reenter) _callback();
        bool result = super.transfer(to, amount);
        if (mode == Mode.NoReturn) assembly { return(0, 0) }
        return result;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (mode == Mode.Reenter) _callback();
        return super.transferFrom(from, to, amount);
    }

    function _callback() private {
        (bool ok, bytes memory reason) = callbackTarget.call(callbackData);
        reentryBlocked = !ok && isReentryError(reason);
    }
}

function isReentryError(bytes memory reason) pure returns (bool) {
    return keccak256(reason) == keccak256(abi.encodeWithSignature("Error(string)", "ReentrancyGuard: reentrant call"));
}

abstract contract TestPool {
    using SafeERC20 for IERC20;
    enum Mode {
        Normal,
        Reject,
        Partial,
        Reenter
    }
    Mode public mode;
    IERC20 public immutable token;
    uint256 public calls;
    bool public reentryBlocked;
    bytes public callbackData;
    bytes32 public lastCallHash;
    error PoolRejected();

    constructor(IERC20 asset) {
        token = asset;
    }

    function configure(Mode next) external {
        mode = next;
    }

    function setCallback(bytes memory data) external {
        callbackData = data;
    }

    function _take(uint256 amount) internal {
        if (mode == Mode.Reject) revert PoolRejected();
        if (mode == Mode.Reenter) {
            (bool ok, bytes memory reason) = msg.sender.call(callbackData);
            reentryBlocked = !ok && isReentryError(reason);
        }
        calls++;
        lastCallHash = keccak256(msg.data);
        token.safeTransferFrom(msg.sender, address(this), mode == Mode.Partial ? amount - 1 : amount);
    }
}

abstract contract DepositFixture is Test {
    DepositFactory internal factory;
    DepositConfig internal config;
    TestToken internal token;
    TestToken internal wrongToken;
    TestPool internal pool;
    address internal factoryAddress;
    address internal depositAddress;
    address internal recovery;
    address internal relayer;
    address internal feeRecipient;
    address internal attacker;
    bytes32 internal salt;
    uint256 internal quote;
    uint256 internal gasCharge;

    function _initialize(uint256 amount, uint256 gasFee) internal {
        token = new TestToken();
        wrongToken = new TestToken();
        recovery = makeAddr("recovery");
        relayer = makeAddr("relayer");
        feeRecipient = makeAddr("fees");
        attacker = makeAddr("attacker");
        salt = keccak256("deposit salt");
        quote = amount;
        gasCharge = gasFee;
        _setUpProtocol();
        depositAddress = _predict();
        pool.setCallback(_relayData());
    }

    function _setUpProtocol() internal virtual;
    function _predict() internal view returns (address) { return factory.computeAddress(salt, config); }
    function _deploy() internal returns (DepositBase) { return factory.deploy(salt, config); }
    function _relay(bool viaFactory) internal {
        if (viaFactory) factory.deployAndExecute(salt, config, _execution(gasCharge), _protocolData());
        else DepositBase(depositAddress).execute(_execution(gasCharge), _protocolData());
    }
    function _execution(uint256 fee) internal view returns (DepositQuote memory) {
        return DepositQuote(token, quote, fee, type(uint256).max);
    }
    function _relayData() internal view returns (bytes memory) {
        return abi.encodeCall(DepositBase.execute, (_execution(gasCharge), _protocolData()));
    }
    function _protocolData() internal view virtual returns (bytes memory);
    function _consumed(uint256) internal view returns (uint256) { return quote; }
    function _insufficientError() internal pure returns (bytes4) { return DepositBase.InvalidBalance.selector; }
    function _replayError() internal pure returns (bytes4) { return DepositBase.AlreadyExecuted.selector; }
    function _poolBalanceError() internal pure returns (bytes4) { return DepositBase.IncompleteDeposit.selector; }
    function _expectedCallHash(uint256 consumed) internal view virtual returns (bytes32);

    function _assertBindings() internal view {
        DepositBase forwarder = DepositBase(depositAddress);
        assertEq(forwarder.factory(), factoryAddress);
        assertEq(forwarder.recovery(), recovery);
        assertEq(forwarder.relayer(), relayer);
        assertEq(forwarder.feeRecipient(), feeRecipient);
        assertEq(DepositBase(depositAddress).SERVICE_FEE_BPS(), 10);
    }
}
