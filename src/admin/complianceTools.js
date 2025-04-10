/*************************************************************
 * complianceTools.js
 * 
 * Location: /src/admin/complianceTools.js
 * 
 * Consolidates references from:
 *  - Prompt 7.9: setUserRiskRating(...), region detection, KYC
 *  - Prompt 7.10: compliance override => block/unblock user, store compliance notes
 * 
 * Exports:
 *  1) setUserRiskRating(adminId, userId, newRating)
 *  2) getUserRiskRating(userId)
 *  3) blockUserCompliance(adminId, userId, reason)
 *  4) unblockUserCompliance(adminId, userId)
 *  5) setComplianceNotes(adminId, userId, notes)
 *************************************************************/

const { query } = require('../database/database');
const { logAdminAction } = require('./adminLogs');
const notifications = require('../utils/notifications');

const MESSAGES = {
  BLOCK_REASON: (reason) => `Blocked reason: ${reason}`,
};

const SQL_QUERIES = {
  BLOCK_USER: `
    UPDATE users
    SET compliance_blocked = true,
        compliance_notes = CONCAT(COALESCE(compliance_notes,''), ' | ', $2)
    WHERE id = $1
  `,
};

/*******************************************************************************************************
 * setUserRiskRating
 * - Admin sets a user's risk rating (e.g. 'low', 'medium', 'high', 'restricted')
 * - Could be triggered by region, deposit size, or manual override
 *************************************************************/
async function setUserRiskRating(adminId, userId, newRating = 'medium') {
  try {
    const validRatings = ['low', 'medium', 'high', 'restricted'];
    if (!validRatings.includes(newRating)) {
      throw new Error(`Invalid risk rating "${newRating}". Must be one of: ${validRatings.join(', ')}`);
    }

    await query(`
      UPDATE users
      SET risk_rating = $1
      WHERE id = $2
    `, [newRating, userId]);

    // Log admin action
    await logAdminAction(adminId, 'setUserRisk', `userId=${userId}, rating=${newRating}`);
  } catch (err) {
    console.error('Error setting user risk rating:', err);
    throw err;
  }
}

/*******************************************************************************************************
 * getUserRiskRating
 * - Retrieve a user's risk rating
 *************************************************************/
async function getUserRiskRating(userId) {
  const res = await query(`
    SELECT risk_rating
    FROM users
    WHERE id = $1
  `, [userId]);

  if (res.rows.length === 0) {
    throw new Error(`User not found: ${userId}`);
  }
  return res.rows[0].risk_rating;
}

/*****************************************************************************************************
 * blockUserCompliance
 * - Admin forcibly blocks a user from trading for compliance reasons
 *   e.g. restricted region, suspicious activity
 *************************************************************/
async function blockUserCompliance(adminId, userId, reason = 'No reason provided') {
  if (reason.length > 255) {
    throw new Error('Reason must be 255 characters or less.');
  }

  await query(`
    UPDATE users
    SET compliance_blocked = true,
        compliance_notes = CONCAT(COALESCE(compliance_notes,''), ' | Blocked reason: ', $2)
    WHERE id = $1
  `, [userId, reason]);

  await logAdminAction(adminId, 'block_user_compliance', `userId=${userId}, reason=${reason}`);

  // Notify compliance team
  notifications.sendAdminGlobalAlert(`User ${userId} has been blocked for compliance reasons: ${reason}`);
}

/*************************************************************
 * unblockUserCompliance
 * - Admin re-allows a user to trade
 *************************************************************/
async function unblockUserCompliance(adminId, userId) {
  await query(`
    UPDATE users
    SET compliance_blocked = false
    WHERE id = $1
  `, [userId]);

  // Optionally log a note in compliance_notes
  await query(`
    UPDATE users
    SET compliance_notes = CONCAT(COALESCE(compliance_notes,''), ' | Unblocked by adminId=', $2)
    WHERE id = $1
  `, [userId, adminId]);

  await logAdminAction(adminId, 'unblock_user_compliance', `userId=${userId}`);
}

/*************************************************************
 * setComplianceNotes
 * - Admin can add a note to a user's compliance_notes
 *************************************************************/
async function setComplianceNotes(adminId, userId, notes) {
  // Append a timestamp or something if desired
  const noteEntry = `Admin(${adminId}) => ${notes}`;
  await query(`
    UPDATE users
    SET compliance_notes = CONCAT(COALESCE(compliance_notes,''), ' | ', $2)
    WHERE id = $1
  `, [userId, noteEntry]);

  await logAdminAction(adminId, 'setComplianceNotes', `userId=${userId}, notes="${notes}"`);
}

/*************************************************************
 * Exports
 *************************************************************/
module.exports = {
  setUserRiskRating,
  getUserRiskRating,
  blockUserCompliance,
  unblockUserCompliance,
  setComplianceNotes,
};