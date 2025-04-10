/*************************************************************
 * subscriptionBilling.js
 * 
 * Description:
 *  - A cron-scheduled script that checks users whose premium
 *    subscription is expiring or expired, attempts to renew
 *    by deducting from their vault, and handles success/fail.
 *  - Integrates logic from Prompts 13.0 → 13.5.
 * 
 * Usage:
 *  - Place in /scripts/subscriptionBilling.js
 *  - Set up a cron job (node-cron or system-level crontab)
 *  - E.g. "0 0 * * * node scripts/subscriptionBilling.js"
 *  - Or require it in an index.js with node-cron schedule
 *************************************************************/

const cron = require('node-cron');
const web3 = require('@solana/web3.js'); // Added missing import
const { query } = require('../src/database/database'); // or adapt path
const { attemptVaultSubscription } = require('./vaultSubscriptionLogic'); 
const notifications = require('../src/utils/notifications'); 

// Validate environment variables
const platformWallet = process.env.PLATFORM_WALLET;
if (!platformWallet) {
  throw new Error('PLATFORM_WALLET environment variable is not set.');
}

// Optionally define or import from your user service:
async function getAllUsersExpiringSoon() {
  const res = await query(`
    SELECT id, premium_expires_at 
    FROM users
    WHERE premium_expires_at < NOW() + INTERVAL '24 hours'
      OR premium_expires_at < NOW()
  `);
  return res.rows;
}

/*************************************************************
 * The main function that runs in a scheduled manner.
 * Steps:
 *  1) Gather users who are nearing or past expiry
 *  2) For each user, try attemptVaultSubscription
 *  3) If fail -> downgrade user to free + notify
 *************************************************************/
async function runBillingCycle() {
  const users = await getAllUsersExpiringSoon();
  
  for (const user of users) {
    const userId = user.id;

    const result = await attemptVaultSubscription(userId);

    if (!result.success) {
      await downgradeUserToFree(userId, result.error);
    } else {
      notifications.sendCustomNotification(
        userId,
        `👑 *Premium Renewed*\n\nWe deducted ${result.amountSOL} SOL from your vault. You are premium until next cycle.\nTx: https://solscan.io/tx/${result.txSignature}`
      );
    }
  }
}

/*************************************************************
 * attemptVaultSubscription(userId)
 * - Handles subscription renewal logic
 *************************************************************/
async function attemptVaultSubscription(userId) {
  try {
    const userRes = await query(`
      SELECT id, premium_expires_at
      FROM users
      WHERE id = $1
    `, [userId]);
    if (userRes.rows.length === 0) {
      return { success: false, error: 'User not found' };
    }

    const { success, error, userKeypair, vaultPubkey } = await loadVaultKeypair(userId);
    if (!success) {
      return { success: false, error };
    }

    const connection = new web3.Connection(web3.clusterApiUrl('mainnet-beta'), 'confirmed');
    const vaultBalanceLamports = await connection.getBalance(vaultPubkey);

    const monthlyFeeLamports = Math.floor((process.env.MONTHLY_FEE_SOL || 0.1) * 1e9);
    if (vaultBalanceLamports < monthlyFeeLamports + 50_000) {
      return { success: false, error: 'Insufficient vault balance' };
    }

    const tx = new web3.Transaction().add(
      web3.SystemProgram.transfer({
        fromPubkey: vaultPubkey,
        toPubkey: new web3.PublicKey(platformWallet),
        lamports: monthlyFeeLamports
      })
    );
    tx.feePayer = vaultPubkey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(userKeypair);
    const txSignature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });
    await connection.confirmTransaction(txSignature, 'confirmed');

    await query(`
      UPDATE users
      SET premium_expires_at = GREATEST(premium_expires_at, NOW()) + INTERVAL '30 days'
      WHERE id = $1
    `, [userId]);

    await query(`
      INSERT INTO vault_transactions
        (user_id, type, amount, token, tx_signature, success)
      VALUES ($1, 'subscription', $2, 'SOL', $3, true)
    `, [userId, 0.1, txSignature]);

    return {
      success: true,
      txSignature,
      amountSOL: 0.1
    };

  } catch (err) {
    await query(`
      INSERT INTO vault_transactions
        (user_id, type, amount, token, success, error_reason)
      VALUES ($1, 'subscription', 0.1, 'SOL', false, $2)
    `, [userId, err.message]);

    return { success: false, error: err.message };
  }
}

/*************************************************************
 * loadVaultKeypair(userId)
 *************************************************************/
async function loadVaultKeypair(userId) {
  try {
    const vaultRes = await query(`
      SELECT vault_priv_key
      FROM user_vaults
      WHERE user_id=$1
    `, [userId]);
    if (vaultRes.rows.length === 0) {
      return { success: false, error: 'No vault found' };
    }
    const encryptedBase64 = vaultRes.rows[0].vault_priv_key;
    const userKeypair = web3.Keypair.fromSecretKey(Buffer.from(encryptedBase64, 'base64'));
    return {
      success: true,
      userKeypair,
      vaultPubkey: userKeypair.publicKey
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/*************************************************************
 * downgradeUserToFree(userId, reason)
 *************************************************************/
async function downgradeUserToFree(userId, failReason = '') {
  await query(`
    UPDATE users
    SET premium_expires_at = NULL,
        user_type='free'
    WHERE id=$1
  `, [userId]);

  await query(`
    INSERT INTO vault_transactions
      (user_id, type, amount, token, success, error_reason)
    VALUES ($1, 'auto_downgrade', 0, 'SOL', false, $2)
  `, [userId, failReason || 'subscription renewal fail']);

  notifications.sendCustomNotification(
    userId,
    `❌ *Premium Expired*\n\nWe could not renew your subscription. Reason: ${failReason}\n` +
    `You have been downgraded to Free tier. Top up your vault and run /renew to try again.`
  );
}

/*************************************************************
 * scheduleBilling()
 *************************************************************/
function scheduleBilling() {
  cron.schedule('0 0 * * *', async () => {
    try {
      await runBillingCycle();
    } catch (err) {
      console.error('Error during billing cycle:', err);
    }
  }, {
    scheduled: true,
    timezone: "UTC"
  });
}

/*************************************************************
 * MAIN ENTRY for subscriptionBilling.js
 *************************************************************/
async function main() {
  console.log(`[subscriptionBilling] Starting the subscription billing cycle...`);
  await runBillingCycle();
  scheduleBilling();
}

if (require.main === module) {
  main();
}

module.exports = {
  runBillingCycle,
  scheduleBilling,
  main
};