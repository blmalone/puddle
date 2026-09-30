import assert from 'node:assert/strict';
import { formatUnits } from 'ethers';
import { brand } from './brand.ts';
import { createEnvironment, createRecipient, prepareDeposit, fund, settle,
  decryptDeposit, saveReport } from './harness.ts';

console.log('Starting a private local Anvil chain and deploying real RAILGUN contracts…');
const env = await createEnvironment();
try {
  const recipient = await createRecipient();
  const amount = 100_000_000n;
  const gasFee = 200_000n; // Illustrative token charge, not a live gas quote.
  const serviceFee = amount / 1_000n;
  const deposit = await prepareDeposit(env, recipient.address, { minDeposit: amount, maxGasFee: 500_000n });
  console.log(`Recipient (test identity): ${recipient.address}`);
  console.log(`CREATE2 deposit address: ${deposit.address}`);
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  const funded = await fund(env, deposit.address, amount);
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  console.log('Sent 100 dUSD with an ordinary token transfer. Address still has no deployed code.');
  const receipt = await settle(env, deposit, gasFee);
  const result = await decryptDeposit(env, recipient, receipt);
  assert.equal(result.amount + result.fee + serviceFee + gasFee, amount);
  console.log(`Relayer deployed the forwarder, collected fees, and shielded the remainder (${receipt.gasUsed} gas).`);
  console.log(`${brand.displayName}: ${formatUnits(serviceFee, 6)} dUSD service fee + ${formatUnits(gasFee, 6)} dUSD illustrative gas charge.`);
  console.log(`Recipient decrypted ${formatUnits(result.amount, 6)} dUSD; pool fee ${formatUnits(result.fee, 6)} dUSD.`);
  console.log('Reconstructed the note commitment and verified its inclusion in the real pool Merkle root.');
  console.log('This verifies deposit + decryption, not a private withdrawal or production proof-of-innocence acceptance.');
  saveReport({ mode: 'isolated local chain', chainId: 31337, recipient: recipient.address,
    depositAddress: deposit.address, pool: await env.pool.getAddress(), token: await env.token.getAddress(),
    fundingTransaction: funded.hash, shieldingTransaction: receipt.hash, shieldingGas: receipt.gasUsed,
    ...result, serviceFee, gasFee, validated: ['fund before deployment', 'ordinary ERC20 transfer', 'capped fee collection', 'relayer-funded shielding',
      'recipient decryption', 'commitment matches real pool', 'Merkle inclusion'],
    notValidated: ['private spend or withdrawal proof', 'production PPOI acceptance', 'production deployment'] });
} finally { await env.close(); }
