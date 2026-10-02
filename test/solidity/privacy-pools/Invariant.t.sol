// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {DepositHandler, DepositInvariantTest} from "../shared/DepositInvariant.sol";
import {PrivacyPoolsFixture} from "./Fixture.sol";

contract PrivacyPoolsHandler is DepositHandler, PrivacyPoolsFixture {
    constructor() {
        _initialize(1_000_000, 1_000);
    }
}

contract PrivacyPoolsInvariantTest is DepositInvariantTest {
    function _createHandler() internal override returns (DepositHandler) {
        return new PrivacyPoolsHandler();
    }
}
