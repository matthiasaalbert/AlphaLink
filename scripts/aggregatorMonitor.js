/*************************************************************
 * aggregatorMonitor.js
 * 
 * Location: /scripts/aggregatorMonitor.js
 * 
 * Purpose:
 *  - Periodically poll aggregator stats (TPS, errorRate, queueLength, etc.)
 *  - Optionally store them in aggregator_stats table or in memory
 *  - Alert admins if thresholds exceed safe levels
 *  - Provide a "live feed" of last trades for the Admin WebApp from 9.0/9.1 
 * 
 * Integration with:
 *  - aggregator.js => We assume aggregator logs data somewhere or we read aggregator logs
 *  - database.js => for storing metrics, fetching recent trades, etc.
 *  - notifications.js => to send admin alerts
 *  - Possibly used by the Admin WebApp to provide real-time stats
 *************************************************************/

const cron = require('node-cron');  // if you want scheduling here
const { query } = require('../src/database/database'); // adapt path to your DB
const notifications = require('../src/utils/notifications'); // adapt if you want to send admin alerts
const web3 = require('@solana/web3.js'); // required for RPC health check

const ERROR_RATE_THRESHOLD = parseFloat(process.env.ERROR_RATE_THRESHOLD || 0.1);
const QUEUE_LENGTH_THRESHOLD = parseInt(process.env.QUEUE_LENGTH_THRESHOLD || 20, 10);

if (ERROR_RATE_THRESHOLD < 0 || ERROR_RATE_THRESHOLD > 1) {
  throw new Error('ERROR_RATE_THRESHOLD must be between 0 and 1.');
}
if (QUEUE_LENGTH_THRESHOLD < 0) {
  throw new Error('QUEUE_LENGTH_THRESHOLD must be a positive integer.');
}

/**
 * Prompt 8.5 suggests we track metrics like:
 *  1. aggregator_tps        # trades per second in last X
 *  2. trade_error_rate      # % fail in last 1-5 minutes
 *  3. avg_trade_latency_ms  # time from execution start -> success
 *  4. queue_length          # how many trades are queued
 *  5. vault_conflict_count  # # of vault lock collisions
 *  6. rpc_health            # check RPC or aggregator route
 *  7. meltdownWarnings      # e.g. meltdown or meltdownMode check
 *  8. recentTrades feed     # last 20 trades for feed
 */

/*************************************************************
 * collectAggregatorMetrics()
 * - fetch aggregator stats from aggregatorStats.js or aggregator logs
 * - or from aggregator.js if it provides an in-memory or DB approach
 *************************************************************/
async function collectAggregatorMetrics() {
  // This function is a placeholder that you fill with actual code:
  // e.g. read aggregator queue, aggregator error counters, last trades from trade_executions table, etc.

  // Example approach:
  // 1) aggregator TPS = count # trades in last 60s from trade_executions
  let tpsRes;
  try {
    tpsRes = await query(`
      SELECT COUNT(*) AS trades_in_60s
      FROM trade_executions
      WHERE executed_at > NOW() - INTERVAL '60 seconds'
    `);
  } catch (err) {
    console.error('Error fetching TPS:', err);
    return null; // or handle appropriately
  }

  if (!tpsRes.rows || tpsRes.rows.length === 0) {
    console.error('No data returned for TPS query');
    return null;
  }

  const tradesIn60 = parseInt(tpsRes.rows[0].trades_in_60s || '0', 10);
  const aggregator_tps = (tradesIn60 / 60).toFixed(2); // trades / second

  // 2) error rate in last 5min
  let errorRes;
  try {
    errorRes = await query(`
      SELECT COUNT(*) FILTER (WHERE status='FAILED') AS fail_count,
             COUNT(*) AS total_count
      FROM trade_executions
      WHERE executed_at > NOW() - INTERVAL '5 minutes'
    `);
  } catch (err) {
    console.error('Error fetching error rate:', err);
    return null; // or handle appropriately
  }
  const failCount = parseInt(errorRes.rows[0].fail_count || '0', 10);
  const totalCount = parseInt(errorRes.rows[0].total_count || '0', 10);
  let trade_error_rate = 0;
  if (totalCount > 0) {
    trade_error_rate = failCount / totalCount;
  }

  // 3) average trade latency
  // If aggregator logs a "latency_ms" in trade_executions, we can do:
  // e.g. SELECT AVG(latency_ms)
  const latencyRes = await query(`
    SELECT AVG(latency_ms)::numeric(10,2) AS avg_latency
    FROM trade_executions
    WHERE executed_at > NOW() - INTERVAL '5 minutes'
      AND status='SUCCESS'
  `);
  const avgLatencyMs = parseFloat(latencyRes.rows[0]?.avg_latency || 0);

  // 4) queue_length => if aggregator maintains an aggregator_queue table or in-memory queue
  // For illustration:
  const queueLen = 0; // replace with real aggregator queue approach

  // 5) vault_conflict_count => # of vault lock collisions in last 1 min (optionally in DB logs)
  const conflictRes = await query(`
    SELECT COUNT(*) AS conflicts
    FROM aggregator_conflicts
    WHERE created_at > NOW() - INTERVAL '1 minute'
  `);
  const vault_conflict_count = parseInt(conflictRes.rows[0]?.conflicts || '0', 10);

  // 6) rpc_health => we could do a quick check, e.g. getLatestBlockhash
  let rpcHealthy = true;
  try {
    const connection = new web3.Connection(web3.clusterApiUrl('mainnet-beta'), 'confirmed');
    await connection.getLatestBlockhash();
  } catch (err) {
    rpcHealthy = false;
    console.error('RPC health check failed:', err);
  }

  // 7) meltdownWarnings => if meltdown mode is triggered from risk_control
  let meltdownWarnings = false;
  // meltdownWarnings = (some check in global_settings or risk_control)

  // 8) recentTrades feed => last 20 trades
  const feedRes = await query(`
    SELECT user_id, from_token, to_token, amount, status, slippage, tx_signature,
           EXTRACT(EPOCH FROM (executed_at)) as time_epoch
    FROM trade_executions
    ORDER BY executed_at DESC
    LIMIT 20
  `);
  const recentTrades = feedRes.rows.map(row => ({
    userId: row.user_id,
    pair: `${row.from_token}→${row.to_token}`,
    amount: row.amount,
    status: row.status,
    slippage: row.slippage,
    txSignature: row.tx_signature,
    time: new Date(row.time_epoch*1000).toISOString(),
  }));

  return {
    aggregator_tps,
    trade_error_rate,
    avgLatencyMs,
    queueLength: queueLen,
    vault_conflict_count,
    rpcHealthy,
    meltdownWarnings,
    recentTrades
  };
}

/*************************************************************
 * handleAggregatorStats(stats)
 * - handle logic for alerts or storing aggregator stats
 * - from prompt 8.5 (monitoring & alerting)
 *************************************************************/
async function handleAggregatorStats(stats) {
  // e.g., store them in aggregator_stats table
  await query(`
    INSERT INTO aggregator_stats (
      tps, error_rate, avg_latency_ms, queue_length, vault_conflicts, rpc_healthy, meltdown_mode
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [
    stats.aggregator_tps,
    stats.trade_error_rate,
    stats.avgLatencyMs,
    stats.queueLength,
    stats.vault_conflict_count,
    stats.rpcHealthy,
    stats.meltdownWarnings
  ]);

  // if error_rate or queueLength is too high => send admin alert
  if (stats.trade_error_rate > ERROR_RATE_THRESHOLD) {
    // 10% error => problem
    notifications.sendAdminGlobalAlert(`
⚠️ *Aggregator High Error Rate* ${ (stats.trade_error_rate * 100).toFixed(1)}%
Check aggregator logs immediately.
`);
  }
  if (stats.queueLength > QUEUE_LENGTH_THRESHOLD) {
    notifications.sendAdminGlobalAlert(`
🚨 *Aggregator Queue Backlog* => ${stats.queueLength} pending trades
Potential slowdown or concurrency issues.
`);
  }
  if (!stats.rpcHealthy) {
    notifications.sendAdminGlobalAlert(`
❌ *Solana RPC Unhealthy*
Check node status or switch endpoints.
`);
  }
}

/*************************************************************
 * runAggregatorMonitor()
 * - the main routine that:
 *   1) collects aggregator stats
 *   2) calls handleAggregatorStats => storing + alerting
 *************************************************************/
async function runAggregatorMonitor() {
  const stats = await collectAggregatorMetrics();
  await handleAggregatorStats(stats);
  // if needed, we can do load testing or other tasks from prompt 8.5
}

/*************************************************************
 * scheduleAggregatorMonitor()
 * - sets up a cron job to run runAggregatorMonitor() 
 *   every X minutes/seconds
 *************************************************************/
function scheduleAggregatorMonitor() {
  // e.g. run every 1 minute => '*/1 * * * *'
  // or every 5 min => '*/5 * * * *'
  cron.schedule('*/5 * * * *', async () => {
    try {
      await runAggregatorMonitor();
    } catch (err) {
      console.error('Error in aggregator monitor cron job:', err);
    }
  }, {
    scheduled: true,
    timezone: "UTC"
  });
}

/*************************************************************
 * main() entry
 * - If we run "node scripts/aggregatorMonitor.js" directly
 *   we do an immediate run + schedule
 *************************************************************/
async function main() {
  console.log(`[aggregatorMonitor] Starting aggregator monitor...`);
  await runAggregatorMonitor(); 
  scheduleAggregatorMonitor();
}

if (require.main === module) {
  // run via "node scripts/aggregatorMonitor.js"
  main();
}

module.exports = {
  runAggregatorMonitor,
  scheduleAggregatorMonitor,
  main
};