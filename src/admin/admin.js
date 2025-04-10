/*************************************************************
 * admin.js — Final Consolidated
 * 
 * Location: /src/admin/admin.js
 * 
 * Includes logic from:
 *  1.3 (Admin Logs & Audit Trails)
 *  1.4 (Role-Based Admin Permissions)
 *  1.5 (Broadcast Alerts & Custom Admin Notifications)
 *  1.6 (Scheduled System Reports)
 *  1.7 (Auto-Triggers & Auto-Responses)
 *  1.8 (System-Wide Risk & Hedging)
 *  1.9 (Market Event Auto-Pause)
 *  1.10 (Safeguards & Circuit Breakers)
 *  1.11 (Final Admin System Consolidation)
 *  2.2 (Trader Deactivation / Reactivation)
 *  2.11 (Trader Management Final Consolidation)
 *  7.9 (Risk Rating)
 *  7.10 (Compliance Override)
 *  9.0 (Admin Monitoring WebApp, if we keep Telegram commands)
 *  9.1 (Live feed partial commands)
 * 13.5 (Manual Premium Grant/Extend)
 *************************************************************/

const { query } = require('../database/database');
const notifications = require('../utils/notifications');
// riskControl for meltdown toggles or globalPause
const riskControl = require('../risk/risk_control');
// if you have aggregator stats for live feed
const { getRecentTradesFeed, collectAggregatorMetrics } = require('../aggregator/aggregatorMetrics');
// if you have a role-based system
// const { isSuperAdmin, isTraderManager, isRiskManager } = require('./adminRoles') 
// or custom approach
const cron = require('node-cron');

/*************************************************************
 * Admin logs => from Prompt 1.3
 * We log each admin action into admin_logs
 *************************************************************/
async function logAdminAction(adminId, action, details = '') {
  try {
    await query(`
      INSERT INTO admin_logs (admin_user, action, details, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [adminId, action, details]);
  } catch (err) {
    console.error('Error logging admin action:', err);
  }
}

async function fetchAdminLogs(limit=10) {
  const res = await query(`
    SELECT id, admin_user, action, details, created_at
    FROM admin_logs
    ORDER BY id DESC
    LIMIT $1
  `, [limit]);
  return res.rows;
}

/*************************************************************
 * Role-Based Admin Permissions => from Prompt 1.4
 *************************************************************/
async function getAdminRole(userId) {
  const res = await query(`
    SELECT role FROM admin_roles
    WHERE user_id=$1
  `, [userId]);
  if(res.rows.length===0) return 'none';
  return res.rows[0].role; // 'superadmin', 'riskmanager', 'tradermanager'
}

async function setAdminRole(adminId, targetUserId, newRole) {
  const adminRole = await getAdminRole(adminId);
  if (adminRole !== 'superadmin') {
    throw new Error('Only superadmins can set admin roles.');
  }
  const allowedRoles = ['superadmin', 'riskmanager', 'tradermanager'];
  if (!allowedRoles.includes(newRole)) {
    throw new Error(`Invalid role: ${newRole}`);
  }
  await logAdminAction(adminId, 'setAdminRole', `target=${targetUserId}, role=${newRole}`);
  await query(`
    INSERT INTO admin_roles (user_id, role)
    VALUES ($1, $2)
    ON CONFLICT (user_id)
    DO UPDATE SET role=$2
  `, [targetUserId, newRole]);
}

/*************************************************************
 * Broadcast Alerts => from Prompt 1.5
 * e.g. /send_alert all "Message"
 *************************************************************/
async function broadcastAlert(adminId, targetGroup, message) {
  await logAdminAction(adminId, 'broadcastAlert', `group=${targetGroup}, msg=${message}`);
  // logic to fetch user ids by group => all, premium, admin
  // notifications.sendCustomNotification to each user
}

/*************************************************************
 * Scheduled System Reports => from Prompt 1.6
 * - Admin can define daily or weekly system summary
 *************************************************************/
async function generateSystemReport() {
  // e.g. aggregator metrics, # new users, # trades, risk alerts
  const stats = await collectAggregatorMetrics();
  // build a summary
  const summary = `
System Report:
TPS: ${stats.aggregator_tps}
ErrorRate: ${(stats.trade_error_rate*100).toFixed(1)}%
Avg Latency: ${stats.avgLatencyMs} ms
QueueLength: ${stats.queueLength}
  `;
  return summary;
}

async function scheduleSystemReport(adminId, frequency='daily') {
  // store in admin_report_schedules table => logic in a cron job
  await logAdminAction(adminId, 'scheduleSystemReport', `freq=${frequency}`);
  // ...
}

cron.schedule('0 0 * * *', async () => {
  const reports = await query(`
    SELECT * FROM admin_report_schedules
    WHERE next_run <= NOW()
  `);
  for (const report of reports.rows) {
    const summary = await generateSystemReport();
    notifications.sendAdminNotification(report.admin_id, summary);
    await query(`
      UPDATE admin_report_schedules
      SET next_run = NOW() + INTERVAL '1 day'
      WHERE id = $1
    `, [report.id]);
  }
});

/*************************************************************
 * Auto-Triggers & Auto-Responses => from Prompt 1.7
 * e.g. auto-block trader if ROI < -10%, etc.
 * admin can define triggers => stored in admin_triggers
 *************************************************************/
async function defineAutoTrigger(adminId, triggerConfig) {
  // e.g. store JSON in admin_triggers table
  await logAdminAction(adminId, 'defineAutoTrigger', JSON.stringify(triggerConfig));
  await query(`
    INSERT INTO admin_triggers (trigger_type, trigger_config, created_by)
    VALUES ($1, $2, $3)
  `, [triggerConfig.type, JSON.stringify(triggerConfig), adminId]);
}

/*************************************************************
 * System-Wide Risk & Hedging => from Prompt 1.8
 * e.g. admin can set global risk thresholds => aggregator
 *************************************************************/
async function setGlobalRiskSetting(adminId, key, value) {
  await query('BEGIN');
  try {
    await logAdminAction(adminId, 'setGlobalRisk', `key=${key}, value=${value}`);
    await query(`
      INSERT INTO global_settings (setting_key, setting_value)
      VALUES ($1, $2)
      ON CONFLICT (setting_key)
      DO UPDATE SET setting_value=$2
    `, [key, value]);
    await query('COMMIT');
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }
}

/*************************************************************
 * Market Event Auto-Pause => from Prompt 1.9
 * e.g. admin can forcibly pause trading on meltdown
 *************************************************************/
async function forceMarketPause(adminId, reason = 'Manual Admin Pause') {
  await logAdminAction(adminId, 'forceMarketPause', reason);
  await riskControl.pauseGlobalTrading(reason);
  const superadmins = await query(`
    SELECT user_id FROM admin_roles WHERE role='superadmin'
  `);
  for (const admin of superadmins.rows) {
    notifications.sendAdminNotification(admin.user_id, `Market paused: ${reason}`);
  }
}

/*************************************************************
 * Safeguards & Circuit Breakers => from Prompt 1.10
 * admin sets thresholds => aggregator or meltdown watchers
 *************************************************************/
async function setCircuitBreaker(adminId, config) {
  // e.g. store circuit_breaker config
  await logAdminAction(adminId, 'setCircuitBreaker', JSON.stringify(config));
  await query(`
    INSERT INTO circuit_breakers (config, created_at, created_by)
    VALUES ($1, NOW(), $2)
  `, [JSON.stringify(config), adminId]);
}

/*************************************************************
 * Final Admin System Consolidation => from Prompt 1.11
 * This file is effectively the consolidated code itself.
 *************************************************************/

/*************************************************************
 * Trader Deactivation / Reactivation => from Prompt 2.2
 *************************************************************/
async function deactivateTrader(adminId, traderId) {
  await logAdminAction(adminId, 'deactivateTrader', `traderId=${traderId}`);
  await query(`
    UPDATE traders
    SET is_active=false
    WHERE id=$1
  `, [traderId]);
  // maybe force auto-switch for all users following that trader
}

async function reactivateTrader(adminId, traderId) {
  await logAdminAction(adminId, 'reactivateTrader', `traderId=${traderId}`);
  await query(`
    UPDATE traders
    SET is_active=true
    WHERE id=$1
  `, [traderId]);
}

/*************************************************************
 * Risk Rating => from Prompt 7.9
 * Admin can set user risk
 *************************************************************/
async function setUserRiskRating(adminId, userId, rating) {
  await logAdminAction(adminId, 'setUserRisk', `userId=${userId}, rating=${rating}`);
  await query(`
    UPDATE users
    SET risk_rating=$1
    WHERE id=$2
  `, [rating, userId]);
}

/*************************************************************
 * Compliance Override => from Prompt 7.10
 * block / restrict user
 *************************************************************/
async function complianceOverride(adminId, userId, blocked=true, notes='') {
  await logAdminAction(adminId, (blocked ? 'blockUser' : 'unblockUser'), `userId=${userId}, ${notes}`);
  await query(`
    UPDATE users
    SET compliance_blocked=$1, compliance_notes=$2
    WHERE id=$3
  `, [blocked, notes, userId]);
}

/*************************************************************
 * Admin Monitoring WebApp => from Prompt 9.0
 * If you keep a Telegram-based approach, you might have commands
 * but let's assume you store data for the web app.
 *************************************************************/
async function getAdminLiveMetrics() {
  // aggregator stats + meltdown checks + queue length
  const stats = await collectAggregatorMetrics();
  const recentTrades = await getRecentTradesFeed(20);
  return {
    ...stats,
    recentTrades
  };
}

/*************************************************************
 * Live feed partial commands => from Prompt 9.1
 * If you want inline commands in Telegram to show the feed
 *************************************************************/
async function commandLiveFeed(ctx) {
  // fetch feed, display in a message
  const feed = await getRecentTradesFeed(10);
  let msg = `Live Trade Feed (last 10):\n`;
  feed.forEach((trade) => {
    msg += `${trade.time} | ${trade.pair} | ${trade.amount} | ${trade.status}\n`;
  });
  return ctx.reply(msg);
}

/*************************************************************
 * Manual Premium Grant/Extend => from Prompt 13.5
 * e.g. /grantpremium [userId] [days]
 *************************************************************/
const MESSAGES = {
  PREMIUM_GRANTED: (days) => `You have been granted Premium for ${days} days by an Admin. Enjoy your perks!`,
};

async function grantPremium(adminId, targetUserId, days=30) {
  await logAdminAction(adminId, 'grant_premium', `userId=${targetUserId}, days=${days}`);
  // set user to premium, extend expiration
  await query(`
    UPDATE users
    SET user_type='premium',
        premium_expires_at = GREATEST(premium_expires_at, NOW()) + ($1 || ' days')::interval
    WHERE id=$2
  `, [days, targetUserId]);

  // notify user
  notifications.sendUserNotification(targetUserId, MESSAGES.PREMIUM_GRANTED(days));
}

/*************************************************************
 * Export All Admin Functions
 *************************************************************/
module.exports = {
  // Logs
  logAdminAction,
  fetchAdminLogs,

  // Roles & Permissions
  getAdminRole,
  setAdminRole,

  // Alerts & Broadcast
  broadcastAlert,

  // System Reports
  generateSystemReport,
  scheduleSystemReport,

  // Auto-Triggers
  defineAutoTrigger,

  // Global Risk & Hedging
  setGlobalRiskSetting,

  // Market Event / meltdown
  forceMarketPause,
  setCircuitBreaker,

  // Trader Management
  deactivateTrader,
  reactivateTrader,

  // Risk Rating & Compliance
  setUserRiskRating,
  complianceOverride,

  // Admin Monitoring
  getAdminLiveMetrics,
  commandLiveFeed,

  // Premium Override
  grantPremium
};