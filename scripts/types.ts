import type { ViewingKeyPair } from '@railgun-community/engine';
import type { BaseContract, BaseContractMethod, BytesLike, ContractRunner,
  ContractTransactionResponse, JsonFragment, JsonRpcProvider, JsonRpcSigner } from 'ethers';
// These type-only paths match the pinned engine's internal ABI definitions.
import type { RailgunSmartWallet, ShieldCiphertextStruct } from
  '../node_modules/@railgun-community/engine/dist/abi/typechain/RailgunSmartWallet.js';

type Read<Args extends unknown[], Result> = BaseContractMethod<Args, Result, Result>;
type Write<Args extends unknown[], Result = void> =
  BaseContractMethod<Args, Result, ContractTransactionResponse>;

export interface TokenContract extends BaseContract {
  connect(runner: ContractRunner | null): TokenContract;
  symbol: Read<[], string>;
  balanceOf: Read<[owner: string], bigint>;
  allowance: Read<[owner: string, spender: string], bigint>;
  deposit: Write<[]>;
  mint: Write<[recipient: string, amount: bigint]>;
  transfer: Write<[recipient: string, amount: bigint], boolean>;
}

export type DepositArguments = [
  salt: string, token: string, notePublicKey: BytesLike,
  ciphertext: ShieldCiphertextStruct, recovery: string,
];

export interface DepositFactory extends BaseContract {
  connect(runner: ContractRunner | null): DepositFactory;
  computeAddress: Read<DepositArguments, string>;
  deploy: Write<DepositArguments, string>;
  deployAndShield: Write<DepositArguments, string>;
}

export interface DepositForwarder extends BaseContract {
  connect(runner: ContractRunner | null): DepositForwarder;
  shield: Write<[]>;
  recover: Write<[token: string]>;
}

export interface ContractArtifact {
  abi: JsonFragment[];
  evm: {
    bytecode: {
      object: string;
      linkReferences: Record<string, Record<string, { start: number; length: number }[]>>;
    };
  };
  storageLayout: { storage: { label: string; slot: string }[] };
}

export type CompiledContracts = Record<string, Record<string, ContractArtifact>>;

export interface CompilerOutput {
  contracts?: CompiledContracts;
  errors?: { severity: string; formattedMessage: string }[];
}

export interface ForkConfig {
  rpc: string;
  block: number;
  pool: string;
  token: string;
}

export interface DepositPath {
  index: bigint;
  treeNumber: bigint;
  siblings: string[];
}

export interface Environment {
  provider: JsonRpcProvider;
  close(): Promise<void>;
  contracts: CompiledContracts;
  fork?: ForkConfig;
  pool: RailgunSmartWallet;
  token: TokenContract;
  factory: DepositFactory;
  deployer: JsonRpcSigner;
  sender: JsonRpcSigner;
  relayer: JsonRpcSigner;
  recovery: JsonRpcSigner;
  attacker: JsonRpcSigner;
  treasury: JsonRpcSigner;
  forwarderAt(address: string, signer?: JsonRpcSigner): DepositForwarder;
  depositPath?: DepositPath;
}

export interface Recipient {
  address: string;
  masterPublicKey: bigint;
  viewing: ViewingKeyPair;
}

export interface PreparedDeposit {
  address: string;
  args: DepositArguments;
}
