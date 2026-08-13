/**
 * usage-payload.js
 *
 * Reads what a /usage response actually establishes — as opposed to what it
 * appears to say.
 *
 * A live usage window always carries a resets_at timestamp. A payload where
 * every window lacks one is claude.ai answering 200 with everything zeroed:
 * a dead session, a removed device, or an organizationId pointing at an org
 * that holds no usage.
 *
 * That shape is genuinely ambiguous — an account that has sent nothing for
 * seven days returns exactly the same thing — so it is never treated as an
 * error. It only downgrades what the UI is allowed to claim.
 */

/**
 * True when no usage window in the payload has a reset timestamp.
 * @param {Object} data - Parsed /usage response
 * @returns {boolean}
 */
function isEmptyUsagePayload(data) {
  return !data?.five_hour?.resets_at && !data?.seven_day?.resets_at;
}

/**
 * Whether an empty payload is better explained by the selected organization
 * being the wrong one than by an idle account.
 *
 * The payload alone can't separate the two, so two cheaper facts decide:
 *
 * - `orgHasHistory` — the widget's own per-org usage history. This is the
 *   signal that identified the original incident: the org it had switched to
 *   had no history key at all, while the previous one held 1446 samples. An
 *   org that has produced usage recently and is quiet now is simply idle, and
 *   warning about it would be noise — daily noise, on accounts whose plan
 *   never reports a seven_day window, since for those "no 5h window open" and
 *   "empty payload" are the same state every morning.
 * - `chatOrgCount` — with a single organization there is nowhere else to look,
 *   so the warning would name a remedy that doesn't exist.
 *
 * @param {{emptyPayload: boolean, orgHasHistory: boolean, chatOrgCount: number}} facts
 * @returns {boolean}
 */
function looksLikeWrongOrg({ emptyPayload, orgHasHistory, chatOrgCount }) {
  return emptyPayload && !orgHasHistory && chatOrgCount > 1;
}

module.exports = { isEmptyUsagePayload, looksLikeWrongOrg };
