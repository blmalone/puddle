// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IRailgun, ShieldRequest} from "../../contracts/protocols/RailgunDeposit.sol";
import {DepositBase, DepositQuote} from "../../contracts/DepositBase.sol";

// Adversarial fixtures only. None of these contracts is used by scripts or live deployments.
contract AdversarialToken is ERC20 {
    enum Mode { Normal, ReturnFalse, Tax, Reenter, NoReturn }
    Mode public mode;
    address public target;
    bool public reentryBlocked;

    constructor() ERC20("Adversarial", "BAD") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function configure(Mode next, address forwarder) external { mode = next; target = forwarder; }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (mode == Mode.ReturnFalse) return false;
        if (mode == Mode.Tax) {
            _burn(msg.sender, 1);
            return super.transfer(to, amount - 1);
        }
        if (mode == Mode.Reenter) {
            (bool ok, bytes memory reason) = target.call(abi.encodeCall(DepositBase.execute, (DepositQuote(IERC20(address(0)), 1, 0, type(uint256).max), "")));
            reentryBlocked = !ok && keccak256(reason) == keccak256(
                abi.encodeWithSignature("Error(string)", "ReentrancyGuard: reentrant call")
            );
        }
        bool result = super.transfer(to, amount);
        if (mode == Mode.NoReturn) { assembly { return(0, 0) } }
        return result;
    }
}
contract AdversarialPool is IRailgun {
    enum Mode { Normal, Revert, Partial, Reenter }
    Mode public mode;
    bool public reentryBlocked;

    function configure(Mode next) external { mode = next; }

    function shield(ShieldRequest[] calldata requests) external {
        require(mode != Mode.Revert, "Shield rejected");
        if (mode == Mode.Reenter) {
            (bool ok, bytes memory reason) = msg.sender.call(abi.encodeCall(DepositBase.execute, (DepositQuote(IERC20(address(0)), 1, 0, type(uint256).max), "")));
            reentryBlocked = !ok && keccak256(reason) == keccak256(
                abi.encodeWithSignature("Error(string)", "ReentrancyGuard: reentrant call")
            );
        }
        uint256 amount = requests[0].preimage.value;
        if (mode == Mode.Partial) amount -= 1;
        IERC20(requests[0].preimage.token.tokenAddress).transferFrom(msg.sender, address(this), amount);
    }
}
