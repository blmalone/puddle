// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {DepositHandler, DepositInvariantTest} from "../shared/DepositInvariant.sol";
import {RailgunFixture} from "./Fixture.sol";

contract RailgunHandler is DepositHandler, RailgunFixture {
    constructor() {
        _initialize(1_000_000, 1_000);
    }
}

contract RailgunInvariantTest is DepositInvariantTest {
    function _createHandler() internal override returns (DepositHandler) {
        return new RailgunHandler();
    }
}
