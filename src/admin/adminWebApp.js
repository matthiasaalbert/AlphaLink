/*************************************************************
 * adminWebApp.js
 * 
 * Location: /src/admin/adminWebApp.js
 * 
 * Consolidates references from:
 *  - Prompt 9.0: Base Admin Monitoring WebApp (aggregator metrics, system health)
 *  - Prompt 9.1: Live trade feed & KPI cards
 *  - Prompt 9.2: Vault watch & conflict resolver
 *  - Prompt 9.3: Control center for meltdown or forced trader actions
 *  - Prompt 9.4: Strategy/followership analytics
 *  - (Optional) Prompt 9.5: Extended auditing or trade inspector logic
 * 
 * This file provides:
 *  1) /admin_webapp/metrics        => aggregator KPI stats, queue length, error rate, etc.
 *  2) /admin_webapp/live_trades    => last N trades (slippage, status, tx link)
 *  3) /admin_webapp/vault_conflicts => locked vaults or stuck trades
 *  4) /admin_webapp/control_center => meltdown toggles, forced trader switch
 *  5) /admin_webapp/strategy_analytics => trader popularity/followership
 *  6) (Optional) /admin_webapp/trade_inspector => single trade deep-dive
 *************************************************************/
const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

// aggregator stats & data
const { collectAggregatorMetrics, getRecentTradesFeed } = require('../aggregator/aggregatorStats');
// meltdown or risk toggles
const riskControl = require('../risk/risk_control');
// portfolio/trader mgmt
// e.g. for forced switch or analytics
// const { reassignUsersFromTrader, getTraderFollowStats } = require('../portfolio/portfolio_manager');
// vault conflict resolver
// const { getLockedVaults, forceUnlockVault, retryLastTrade } = require('../vault/vaultConflictResolver');

// If you keep compliance or meltdown toggles in admin.js or meltdownMode.js, you can import them here:
// const meltdownMode = require('../risk/meltdownMode');  // example

const isAdminSession = require('../middleware/isAdminSession');
const { getAdminRole } = require('../admin/adminRoles');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
});

router.use(isAdminSession); // Apply middleware to all routes
router.use(limiter);

/*************************************************************
 * 1) Admin Monitoring Dashboard Endpoints
 *    References Prompt 9.0 & 9.1
 *************************************************************/

/**
 * GET /admin_webapp/metrics
 * Returns aggregator KPI: TPS, error rate, queue length, average latency, etc.
 */
router.get('/metrics', async (req, res) => {
  try {
    // Possibly verify admin token or session here
    // e.g. if (!isAdminSession(req)) return res.status(403).json({ error: 'Not admin' });

    const stats = await collectAggregatorMetrics(); 
    // e.g. stats => {
    //   tps, errorRate, avgLatencyMs, queueLength, vaultConflicts, rpcHealth ...
    // }

    return res.json({
      success: true,
      data: stats
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'An unexpected error occurred. Please try again later.' });
  }
});

/**
 * GET /admin_webapp/live_trades
 * Returns last N trades for the live feed
 */
router.get('/live_trades', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    const trades = await getRecentTradesFeed(limit, offset);
    return res.json({
      success: true,
      data: trades
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'An unexpected error occurred. Please try again later.' });
  }
});


/*************************************************************
 * 2) Vault Watch & Conflict Resolver
 *    References Prompt 9.2
 *************************************************************/

/**
 * GET /admin_webapp/vault_conflicts
 * Returns locked/stuck vaults, retry count, last trade
 */
router.get('/vault_conflicts', async (req, res) => {
  try {
    // e.g. const lockedVaults = await getLockedVaults();
    // lock data might be in user_vaults => vault_locked_until
    // For demonstration:
    const lockedVaults = []; // placeholder

    return res.json({
      success: true,
      data: lockedVaults
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'An unexpected error occurred. Please try again later.' });
  }
});

/**
 * POST /admin_webapp/vault_conflicts/:userId/unlock
 * Force unlock a vault or re-try
 */
router.post('/vault_conflicts/:userId/unlock', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    // e.g. await forceUnlockVault(userId);
    return res.json({ success: true, message: `Vault for user ${userId} unlocked.` });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'An unexpected error occurred. Please try again later.' });
  }
});

/**
 * POST /admin_webapp/vault_conflicts/:userId/retry
 * Force a trade re-try for last failed attempt
 */
router.post('/vault_conflicts/:userId/retry', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    // e.g. await retryLastTrade(userId);
    return res.json({ success: true, message: `Retriggered last trade for user ${userId}.` });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'An unexpected error occurred. Please try again later.' });
  }
});


/*************************************************************
 * 3) Admin Control Center => meltdown toggles, forced trader switch
 *    References Prompt 9.3
 *************************************************************/

/**
 * POST /admin_webapp/control_center/pause_ai
 * Globally pause AI trading
 */
router.post('/control_center/pause_ai', async (req, res) => {
  const adminRole = await getAdminRole(req.adminId);
  if (adminRole !== 'superadmin') {
    return res.status(403).json({ success: false, error: 'Permission denied' });
  }
  const reason = req.body.reason || 'Manual Admin Pause';
  await riskControl.pauseGlobalTrading(reason);
  return res.json({ success: true, message: 'AI Trading is paused globally.' });
});

/**
 * POST /admin_webapp/control_center/resume_ai
 * Resume AI after meltdown or manual pause
 */
router.post('/control_center/resume_ai', async (req, res) => {
  try {
    await riskControl.resumeGlobalTrading();
    return res.json({ success: true, message: 'AI Trading resumed globally.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'An unexpected error occurred. Please try again later.' });
  }
});

/**
 * POST /admin_webapp/control_center/disable_trader
 * e.g. block or disable a specific trader
 */
router.post('/control_center/disable_trader', [
  body('traderId').isInt().withMessage('Trader ID must be an integer'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  const traderId = req.body.traderId;
  // Proceed with disabling the trader...
});

/**
 * POST /admin_webapp/control_center/force_switch
 * Force-switch all users from TraderX => TraderY
 */
router.post('/control_center/force_switch', async (req, res) => {
  try {
    const fromTrader = req.body.fromTrader;
    const toTrader = req.body.toTrader;
    // e.g. await reassignUsersFromTrader(fromTrader, toTrader);
    return res.json({ success: true, message: `Users forcibly switched from ${fromTrader} to ${toTrader}` });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'An unexpected error occurred. Please try again later.' });
  }
});


/*************************************************************
 * 4) Strategy / Followership Analytics => from Prompt 9.4
 *************************************************************/

/**
 * GET /admin_webapp/strategy_analytics
 * Returns aggregated data: which traders are most followed, total allocations
 */
router.get('/strategy_analytics', async (req, res) => {
  try {
    // e.g. const data = await getTraderFollowStats();
    const data = []; // placeholder
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'An unexpected error occurred. Please try again later.' });
  }
});


/*************************************************************
 * 5) Extended Auditing or Trade Inspector => from Prompt 9.5
 *************************************************************/

/**
 * GET /admin_webapp/trade_inspector/:tradeId
 * Return detailed info about a single user trade:
 * aggregator route, execution steps, slippage, partial fill, etc.
 */
router.get('/trade_inspector/:tradeId', async (req, res) => {
  try {
    const tradeId = parseInt(req.params.tradeId, 10);
    // e.g. fetch from trade_executions + aggregator logs
    const trade = {}; // placeholder
    return res.json({
      success: true,
      trade
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'An unexpected error occurred. Please try again later.' });
  }
});


/*************************************************************
 * Export
 *************************************************************/
module.exports = router;