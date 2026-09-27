/**
 * org-selection.js
 *
 * Normalizes /api/organizations, and chooses which organization the widget
 * polls for usage.
 *
 * Why this is its own module:
 * that choice is re-taken on *every* re-authentication — silent refresh,
 * external-browser renewal, embedded login window, manual key paste — and
 * getting it wrong fails silently. An organization that holds no usage still
 * answers 200 with every counter at zero, so the widget keeps reporting
 * "0% — Not started" instead of erroring out. Pulled out of main.js so the
 * rule can be tested without booting Electron.
 */

// Orgs without this capability are API-only and have no chat usage to report.
const CHAT_CAPABILITY = 'chat';

/**
 * Reduce a raw /api/organizations response to the chat-capable orgs, in the
 * shape the rest of the app speaks. Normalizing once at this boundary keeps
 * the API's two id spellings (uuid/id) and raven_type out of everything
 * downstream.
 *
 * @param {Array<Object>} orgs - Raw /api/organizations response
 * @returns {Array<{id: string, name: string, isTeam: boolean}>}
 */
function toChatOrgSummaries(orgs) {
  if (!Array.isArray(orgs)) return [];

  return orgs
    .filter((org) => org && org.capabilities && org.capabilities.includes(CHAT_CAPABILITY))
    .map((org) => ({
      id: org.uuid || org.id,
      name: org.name,
      isTeam: org.raven_type === 'team'
    }));
}

/**
 * Which organization to poll, in order of authority:
 *
 *  1. 'active'     — the one already in service
 *  2. 'preference' — the last one in service before a session expiry cleared
 *                    the active credentials. Without this rung the whole rule
 *                    is decorative: the expiry cleanup that precedes every
 *                    automatic re-authentication wipes the active org, so
 *                    rung 1 is always empty at exactly the moment a
 *                    re-authentication asks the question.
 *  3. 'default'    — Teams org first, else the first chat org. A
 *                    first-connection default, never a re-decision.
 *
 * Both remembered ids are checked against the account's real org list, so one
 * left over from another account is discarded rather than applied.
 *
 * @param {Array<{id: string, isTeam: boolean}>} chatOrgs - From toChatOrgSummaries
 * @param {string|null} activeOrgId - Currently polled org, if any
 * @param {string|null} preferredOrgId - Last org in service, kept across an expiry
 * @returns {{organizationId: string, source: 'active'|'preference'|'default'}}
 */
function pickOrganizationId(chatOrgs, activeOrgId, preferredOrgId) {
  if (!Array.isArray(chatOrgs) || chatOrgs.length === 0) {
    throw new Error('pickOrganizationId requires at least one chat organization');
  }

  const remembered = [
    { id: activeOrgId, source: 'active' },
    { id: preferredOrgId, source: 'preference' }
  ];

  for (const candidate of remembered) {
    if (candidate.id && chatOrgs.some((org) => org.id === candidate.id)) {
      return { organizationId: candidate.id, source: candidate.source };
    }
  }

  // Prioritize Teams org if present, otherwise use first chat org
  const defaultOrg = chatOrgs.find((org) => org.isTeam) || chatOrgs[0];
  return { organizationId: defaultOrg.id, source: 'default' };
}

module.exports = { toChatOrgSummaries, pickOrganizationId };
