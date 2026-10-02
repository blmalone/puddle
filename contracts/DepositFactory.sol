// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {DepositBase, DepositConfig, DepositQuote, IERC20, IFeePolicy, validateParties,
    InvalidConfiguration, UnauthorizedRelayer} from "./DepositBase.sol";

/// @dev Construction-only policy, in token base units and basis points. Bounds a charge, not actual gas spent.
struct TokenPolicy {
    IERC20 token;
    uint120 maxGasFee;
    uint16 maxGasFeeBps;
}

/// @notice Shared CREATE2 deployment and fee policy. No owner, setters, upgrades or withdrawal authority.
abstract contract DepositFactory is IFeePolicy {
    address public immutable pool;
    struct GasPolicy {
        uint120 fixedAllowance;
        uint16 basisPoints;
        bool supported;
    }
    mapping(IERC20 => GasPolicy) public gasPolicies;

    error InvalidPool();
    error UnsupportedAsset();
    error InvalidAmount();
    event Deployed(address indexed deposit, bytes32 indexed salt);
    event TokenPolicySet(address indexed token, uint120 fixedAllowance, uint16 basisPoints);

    constructor(address target, TokenPolicy[] memory policies) {
        if (target.code.length == 0) revert InvalidPool();
        if (policies.length == 0) revert InvalidConfiguration();
        pool = target;
        for (uint256 i; i < policies.length; ++i) {
            TokenPolicy memory policy = policies[i];
            if (address(policy.token).code.length == 0 || gasPolicies[policy.token].supported
                || policy.maxGasFeeBps > 9_990) revert InvalidConfiguration();
            gasPolicies[policy.token] = GasPolicy(policy.maxGasFee, policy.maxGasFeeBps, true);
            emit TokenPolicySet(address(policy.token), policy.maxGasFee, policy.maxGasFeeBps);
        }
    }

    function maxGasFee(IERC20 token, uint256 amount) external view returns (uint256) {
        GasPolicy memory policy = gasPolicies[token];
        if (!policy.supported) revert UnsupportedAsset();
        if (amount == 0 || amount > type(uint120).max) revert InvalidAmount();
        return uint256(policy.fixedAllowance) + amount * policy.basisPoints / 10_000;
    }

    function computeAddress(bytes32 salt, DepositConfig calldata config) public view returns (address predicted) {
        validateParties(config);
        predicted = Create2.computeAddress(salt, keccak256(_initCode(config)));
        if (config.recovery == predicted || config.feeRecipient == predicted) revert InvalidConfiguration();
    }

    /// @notice Permissionless deployment for recovery. Existing deployments are never reconfigured.
    function deploy(bytes32 salt, DepositConfig calldata config) public returns (DepositBase forwarder) {
        address predicted = computeAddress(salt, config);
        if (predicted.code.length != 0) return DepositBase(predicted);
        forwarder = DepositBase(Create2.deploy(0, salt, _initCode(config)));
        emit Deployed(address(forwarder), salt);
    }

    function deployAndExecute(bytes32 salt, DepositConfig calldata config, DepositQuote calldata quote, bytes calldata data)
        external returns (address)
    {
        if (msg.sender != config.relayer) revert UnauthorizedRelayer();
        DepositBase forwarder = deploy(salt, config);
        forwarder.execute(quote, data);
        return address(forwarder);
    }

    // Concrete factories pin one protocol implementation and validate its recipient encoding.
    function _initCode(DepositConfig calldata config) internal view virtual returns (bytes memory);
}
