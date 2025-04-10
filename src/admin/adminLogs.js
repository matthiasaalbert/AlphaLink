/*************************************************************
 * adminLogs.js
 * 
 * Location: /src/admin/adminLogs.js
 * 
 * Consolidates references from:
 * 1) Prompt 1.3 (Core Admin Logs & Audit Trails)
 * 2) Prompt 1.4 (Log role changes)
 * 3) Prompt 1.5 (Log broadcast alerts)
 * 4) Prompt 1.6 (Log scheduling system reports)
 * 5) Prompt 1.7 (Log auto-triggers changes)
 * 6) Prompt 1.8 (Log global risk & hedging config)
 * 7) Prompt 1.9 (Log forced market pauses)
 * 8) Prompt 1.10 (Log circuit breaker updates)
 * 9) Prompt 1.11 (Final admin system consolidation => logs everywhere)
 * 10) Prompt 2.2 (Trader deactivation => logs)
 * 11) Prompt 2.11 (Final trader mgmt => logs)
 * 12) Prompt 7.9 (setUserRiskRating => logs)
 * 13) Prompt 7.10 (compliance override => logs)
 * 14) Prompt 13.5 (grantPremium => logs)
 *************************************************************/

const { query } = require('../database/database');
const notifications = require('../notifications/notifications');

/*************************************************************
 * logAdminAction(adminId, action, details='')
 * - Primary method to insert a row in admin_logs.
 *************************************************************/
async function logAdminAction(adminId, action, details = '') {
  try {
    await query(`
      INSERT INTO admin_logs (admin_user, action, details, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [adminId, action, details]);

    if (action === 'pauseTrading' || action === 'setCircuitBreaker') {
      notifications.sendAdminGlobalAlert(`Critical action logged: ${action}`);
    }
  } catch (err) {
    console.error('Error logging admin action:', err);
  }
}

/*************************************************************
 * fetchAdminLogs(limit=10, offset=0)
 * - Basic function to retrieve the last X admin logs 
 *   in descending order with pagination support.
 *************************************************************/
async function fetchAdminLogs(limit = 10, offset = 0) {
  const res = await query(`
    SELECT id, admin_user, action, details, created_at
    FROM admin_logs
    ORDER BY id DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return res.rows;
}

/*************************************************************
 * fetchAdminLogsByAction(action, limit=10)
 * - Example filter usage: retrieve logs for a specific action
 *************************************************************/
async function fetchAdminLogsByAction(action, limit = 10) {
  const res = await query(`
    SELECT id, admin_user, action, details, created_at
    FROM admin_logs
    WHERE action = $1
    ORDER BY id DESC
    LIMIT $2
  `, [action, limit]);
  return res.rows;
}

/*************************************************************
 * searchAdminLogs(filters = {}, limit = 50)
 * - More advanced filtering (if needed).
 *   For example, you might allow searching by date, admin,
 *   partial text in details, etc.
 *************************************************************/
async function searchAdminLogs(filters = {}, limit = 50) {
  const MAX_LIMIT = 100;
  limit = Math.min(limit, MAX_LIMIT);

  // Build dynamic WHERE
  let whereClauses = [];
  let params = [];
  let idx = 1;

  if (filters.action) {
    whereClauses.push(`action = $${idx++}`);
    params.push(filters.action);
  }
  if (filters.adminUser) {
    whereClauses.push(`admin_user = $${idx++}`);
    params.push(filters.adminUser);
  }
  // Example date range:
  if (filters.since) {
    whereClauses.push(`created_at >= $${idx++}`);
    params.push(filters.since);
  }
  if (filters.until) {
    whereClauses.push(`created_at <= $${idx++}`);
    params.push(filters.until);
  }


  let whereString = '';
  if (whereClauses.length > 0) {
    whereString = whereClauses.join(' AND ');
  }

  const q = `
    SELECT id, admin_user, action, details, created_at
    FROM admin_logs
    ${whereString ? `WHERE ${whereString}` : ''}
    ORDER BY id DESC
    LIMIT $${idx++}
  `;
  params.push(limit);

  const res = await query(q, params);
  return res.rows;
}

/*************************************************************
 * Exports
 *************************************************************/
module.exports = {
  logAdminAction,
  fetchAdminLogs,
  fetchAdminLogsByAction,
  searchAdminLogs
};