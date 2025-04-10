/*************************************************************
 * riskScanner.js
 * 
 * Location: /scripts/riskScanner.js
 * 
 * Purpose:
 *  - Periodically scan for extreme market events ("flash crash" or meltdown).
 *  - If meltdown or high-risk conditions are detected, auto-freeze trading
 *    or trigger circuit breakers from:
 *       • Prompt 1.9 (Market Event Auto-Pause & Liquidity Management)
 *       • Prompt 1.10 (Trade Safeguards & Circuit Breakers)
 *       • Prompt 8.5 (aggregator meltdown warnings)
 *  - Example triggers:
 *     • BTC or SOL price drop > X% in Y min
 *     • aggregator meltdownWarnings (excess error rates, repeated failures)
 *     • liquidity constraints, slippage thresholds
 *  - Integrates with risk_control or meltdownMode to enforce a pause
 *    in aggregator or block trades if meltdown triggered.
 * 
 *************************************************************/

const cron = require('node-cron');
const { query } = require('../src/database/database');  // adapt path to your DB
// If you have meltdown toggles in risk_control:
const riskControl = require('../src/risk/risk_control'); 
const notifications = require('../src/utils/notifications'); // for admin alerts
// aggregatorMetrics for meltdownWarnings or error rates
const { collectAggregatorMetrics } = require('../src/aggregator/aggregatorMetrics');
const fetch = require('node-fetch');

/*************************************************************
 * Configuration for meltdown / circuit-breaker triggers
 *************************************************************/
const RISK_SCANNER_CONFIG = {
  priceDropThreshold: 0.10,   // 10% drop triggers meltdown
  aggregatorErrorRate: 0.15,  // 15% aggregator error => meltdown
  consecutiveFailThreshold: 5 // repeated trade fails in short window => meltdown
};

/*************************************************************
 * checkMarketConditions()
 * - Prompt 1.9 logic: If big drop in key asset (e.g. BTC),
 *   or extreme volatility => meltdown
 *************************************************************/
async function checkMarketConditions() {
  let meltdownTriggered = false;
  try {
    const oldRes = await query(`
      SELECT value::float AS old_price
      FROM global_metrics
      WHERE metric='btc_price'
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    if (!oldRes.rows || oldRes.rows.length === 0) {
      console.error('No BTC price data found in global_metrics');
      return meltdownTriggered;
    }
    const oldPrice = parseFloat(oldRes.rows[0]?.old_price || '0');
    if (oldPrice <= 0) return meltdownTriggered;

    const currentPrice = await fetchCurrentBTCprice();
    if (!currentPrice) return meltdownTriggered;

    const dropPct = (oldPrice - currentPrice) / oldPrice;
    if (dropPct >= RISK_SCANNER_CONFIG.priceDropThreshold) {
      meltdownTriggered = true;
    }
  } catch (err) {
    console.error('Error in checkMarketConditions:', err);
  }
  return meltdownTriggered;
}

async function fetchCurrentBTCprice() {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    const data = await response.json();
    return data.bitcoin.usd;
  } catch (err) {
    console.error('Error fetching BTC price:', err);
    return null;
  }
}

/*************************************************************
 * checkAggregatorMetricsForMeltdown()
 * - from Prompt 8.5 aggregator meltdown warnings / error rates
 *************************************************************/
async function checkAggregatorMetricsForMeltdown() {
  const stats = await collectAggregatorMetrics();
  // meltdown if aggregator error rate > aggregatorErrorRate
  if (stats.trade_error_rate > RISK_SCANNER_CONFIG.aggregatorErrorRate) {
    return true;
  }
  // meltdownWarnings from aggregator logic
  if (stats.meltdownWarnings) {
    return true;
  }
  // e.g. if queue length extremely high => meltdown
  // if (stats.queueLength > 50) ...
  return false;
}

/*************************************************************
 * circuitBreakerChecks()
 * - from Prompt 1.10, repeated fails => meltdown
 *************************************************************/
async function circuitBreakerChecks() {
  // check # of failures in last 2 min
  const failRes = await query(`
    SELECT COUNT(*) AS fail_count
    FROM trade_executions
    WHERE status='FAILED'
      AND executed_at > NOW() - INTERVAL '2 minutes'
  `);
  const failCount = parseInt(failRes.rows[0]?.fail_count || '0', 10);
  if (failCount >= RISK_SCANNER_CONFIG.consecutiveFailThreshold) {
    return true;
  }
  // more checks: if slippage > X or aggregatorStats extremely negative
  return false;
}

/*************************************************************
 * meltdownDetectedAction(reason)
 * - If meltdown triggered => pause aggregator trades,
 *   send admin alert
 *************************************************************/
async function meltdownDetectedAction(reason) {
  await riskControl.pauseGlobalTrading(`riskScanner meltdown => ${reason}`);
  notifications.sendAdminGlobalAlert(`
🚨 *Meltdown Detected*
Reason: ${reason}

Auto-freeze trading has been enabled.
`);
}

/*************************************************************
 * runRiskScanner()
 * - The main function that checks meltdown conditions:
 *   1) Market conditions (Prompt 1.9)
 *   2) aggregator meltdown / error rates (Prompt 8.5)
 *   3) circuit breaker repeated fails (Prompt 1.10)
 *   => meltdownDetectedAction if triggered
 *************************************************************/
async function runRiskScanner() {
  const lockRes = await query(`
    SELECT pg_try_advisory_lock(12345) AS got_lock
  `);
  if (!lockRes.rows[0].got_lock) {
    console.log('Another instance of riskScanner is already running.');
    return;
  }

  try {
    let meltdownTriggered = false;

    const marketMeltdown = await checkMarketConditions();
    if (marketMeltdown) meltdownTriggered = true;

    const aggregatorMeltdown = await checkAggregatorMetricsForMeltdown();
    if (aggregatorMeltdown) meltdownTriggered = true;

    const circuitTripped = await circuitBreakerChecks();
    if (circuitTripped) meltdownTriggered = true;

    if (meltdownTriggered) {
      await meltdownDetectedAction('Flash Crash / aggregator meltdown / circuit breaker');
    }
  } finally {
    await query(`SELECT pg_advisory_unlock(12345)`);
  }
}

/*************************************************************
 * scheduleRiskScanner()
 * - sets up a cron job that runs runRiskScanner() every X min
 *************************************************************/
function scheduleRiskScanner() {
  // e.g. run every 5 min
  cron.schedule('*/5 * * * *', async () => {
    try {
      console.log(`[riskScanner] Checking meltdown or circuit-breakers...`);
      await runRiskScanner();
    } catch (err) {
      console.error('Error in risk scanner cron job:', err);
    }
  }, {
    scheduled: true,
    timezone: "UTC"
  });
}

/*************************************************************
 * main() - If run "node scripts/riskScanner.js" directly
 *************************************************************/
async function main() {
  console.log(`[riskScanner] Starting risk scanner...`);
  await runRiskScanner();
  scheduleRiskScanner();
}

if (require.main === module) {
  main();
}

// Export if needed for external use
module.exports = {
  runRiskScanner,
  scheduleRiskScanner,
  meltdownDetectedAction
};