// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {DepositFixture, TestPool, DepositBase, IERC20} from "../shared/DepositFixture.sol";
import {RailgunDeposit, RailgunDepositFactory, IRailgun, ShieldRequest, ShieldCiphertext,
    CommitmentPreimage, TokenData, TokenType} from "../../../contracts/protocols/RailgunDeposit.sol";
import {DepositConfig, DepositQuote} from "../../../contracts/DepositBase.sol";
import {DepositFactory, TokenPolicy} from "../../../contracts/DepositFactory.sol";

contract RailgunPoolStub is TestPool {
    constructor(IERC20 asset) TestPool(asset) {}

    function shield(ShieldRequest[] calldata requests) external {
        require(requests.length == 1 && requests[0].preimage.token.tokenAddress == address(token));
        _take(requests[0].preimage.value);
    }
}

abstract contract RailgunFixture is DepositFixture {

    function _setUpProtocol() internal override {
        pool = new RailgunPoolStub(token);
        TokenPolicy[] memory policies = new TokenPolicy[](1);
        policies[0] = TokenPolicy(token, uint120(gasCharge), 0);
        factory = new RailgunDepositFactory(address(pool), policies);
        factoryAddress = address(factory);
        config = DepositConfig({
            recipient: abi.encode(bytes32(uint256(123)), ShieldCiphertext({
                encryptedBundle: [bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3))],
                shieldKey: bytes32(uint256(4))
            })),
            recovery: recovery,
            relayer: relayer,
            feeRecipient: feeRecipient
        });
    }

    function _protocolData() internal pure override returns (bytes memory) { return ""; }

    function _expectedCallHash(uint256 consumed) internal view override returns (bytes32) {
        (bytes32 npk, ShieldCiphertext memory ciphertext) = abi.decode(config.recipient, (bytes32, ShieldCiphertext));
        ShieldRequest[] memory requests = new ShieldRequest[](1);
        requests[0] = ShieldRequest({
            preimage: CommitmentPreimage(
                npk,
                TokenData(TokenType.ERC20, address(token), 0),
                uint120(consumed - consumed / 1_000 - gasCharge)
            ),
            ciphertext: ciphertext
        });
        return keccak256(abi.encodeCall(IRailgun.shield, (requests)));
    }
}
