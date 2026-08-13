/**
 * Régression : le 12/08/2026, le widget est resté 19 h à afficher
 * « 0 % — Not started » alors que la session tournait. Aucune erreur : une
 * ré-authentification avait redéduit l'organisation par heuristique et
 * basculé le widget sur une org qui ne porte aucune consommation, laquelle
 * répond 200 avec tous les compteurs à zéro.
 *
 * Lancement : npm test (node:test, aucune dépendance ajoutée).
 *
 * Le script exécute ce fichier directement plutôt que `node --test <glob>` :
 * les motifs glob ne sont acceptés par le lanceur qu'à partir de Node 22, or
 * `engines` déclare un plancher à 18 et les trois workflows CI épinglent 20.
 * Un nouveau fichier de test doit donc être ajouté au script `test`.
 */
const test = require('node:test');
const assert = require('node:assert');

const { toChatOrgSummaries, pickOrganizationId } = require('../src/org-selection');
const { isEmptyUsagePayload, looksLikeWrongOrg } = require('../src/usage-payload');

// Jeu d'orgs représentatif du compte concerné : une perso qui porte la
// consommation, une Teams que l'heuristique préférait à tort.
const PERSONAL = { id: '3b945588-perso', name: 'Perso', isTeam: false };
const TEAM = { id: 'b4427beb-team', name: 'Team', isTeam: true };

// --- Normalisation de /api/organizations ---------------------------------

test('les orgs sans capacité chat sont écartées', () => {
  const raw = [
    { uuid: 'org-api', name: 'API only', capabilities: ['api'] },
    { uuid: 'org-chat', name: 'Chat', capabilities: ['chat', 'api'] }
  ];

  assert.deepStrictEqual(toChatOrgSummaries(raw), [
    { id: 'org-chat', name: 'Chat', isTeam: false }
  ]);
});

test('les deux orthographes d\'identifiant et le type Teams sont normalisés', () => {
  const raw = [
    { uuid: 'par-uuid', name: 'A', capabilities: ['chat'], raven_type: 'team' },
    { id: 'par-id', name: 'B', capabilities: ['chat'] }
  ];

  assert.deepStrictEqual(toChatOrgSummaries(raw), [
    { id: 'par-uuid', name: 'A', isTeam: true },
    { id: 'par-id', name: 'B', isTeam: false }
  ]);
});

test('une réponse inattendue donne une liste vide, pas une exception', () => {
  assert.deepStrictEqual(toChatOrgSummaries(null), []);
  assert.deepStrictEqual(toChatOrgSummaries({ error: 'nope' }), []);
  assert.deepStrictEqual(toChatOrgSummaries([null, {}]), []);
});

// --- Choix de l'organisation ---------------------------------------------

test('l\'organisation en service est conservée si le compte l\'a encore', () => {
  const { organizationId, source } = pickOrganizationId([TEAM, PERSONAL], PERSONAL.id, null);

  assert.strictEqual(organizationId, PERSONAL.id, 'une org Teams présente ne doit plus voler la place');
  assert.strictEqual(source, 'active');
});

test('l\'heuristique Teams-first ne sert qu\'en l\'absence de tout souvenir', () => {
  const { organizationId, source } = pickOrganizationId([PERSONAL, TEAM], null, null);

  assert.strictEqual(organizationId, TEAM.id);
  assert.strictEqual(source, 'default');
});

test('une org stockée disparue du compte retombe sur l\'heuristique', () => {
  const { organizationId, source } = pickOrganizationId([PERSONAL], 'org-revoquee', null);

  assert.strictEqual(organizationId, PERSONAL.id);
  assert.strictEqual(source, 'default');
});

// Le scénario exact de l'incident du 12/08 : l'expiration de session efface
// l'org active AVANT la ré-authentification automatique, donc seule la
// préférence rescapée peut encore empêcher l'heuristique de basculer sur
// l'org muette. Sans ce barreau, tout le reste de la règle est décoratif.
test('après une expiration, la préférence rescapée empêche le basculement', () => {
  const { organizationId, source } = pickOrganizationId([TEAM, PERSONAL], null, PERSONAL.id);

  assert.strictEqual(organizationId, PERSONAL.id);
  assert.strictEqual(source, 'preference');
});

test('l\'org active prime sur la préférence quand les deux sont connues', () => {
  const { organizationId, source } = pickOrganizationId([TEAM, PERSONAL], TEAM.id, PERSONAL.id);

  assert.strictEqual(organizationId, TEAM.id);
  assert.strictEqual(source, 'active');
});

test('une préférence héritée d\'un autre compte est écartée', () => {
  const autreCompte = { id: 'compte-b-org', name: 'Compte B', isTeam: false };
  const { organizationId, source } = pickOrganizationId([autreCompte], null, PERSONAL.id);

  assert.strictEqual(organizationId, autreCompte.id, 'aucune org d\'un autre compte ne doit être appliquée');
  assert.strictEqual(source, 'default');
});

test('la normalisation et le choix s\'enchaînent sur une réponse brute', () => {
  const raw = [
    { uuid: 'b4427beb-team', name: 'Team', capabilities: ['chat'], raven_type: 'team' },
    { uuid: '3b945588-perso', name: 'Perso', capabilities: ['chat'] }
  ];

  const kept = pickOrganizationId(toChatOrgSummaries(raw), '3b945588-perso', null);
  assert.strictEqual(kept.organizationId, '3b945588-perso');
  assert.strictEqual(kept.source, 'active');
});

test('sans aucune org chat, le choix échoue explicitement', () => {
  assert.throws(() => pickOrganizationId([], 'peu-importe', null), /at least one chat organization/);
  assert.throws(() => pickOrganizationId(null, null, null), /at least one chat organization/);
});

// --- Détection du payload vide -------------------------------------------

test('le payload observé le 12/08 est reconnu comme vide', () => {
  // Réponse réelle relevée dans latestUsageData : 200, forme complète, zéros.
  const observed = {
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 0, resets_at: null },
    limits: [{ kind: 'session', percent: 0, resets_at: null, is_active: true }]
  };

  assert.strictEqual(isEmptyUsagePayload(observed), true);
});

test('une seule fenêtre datée suffit à rendre le payload exploitable', () => {
  const sessionOnly = {
    five_hour: { utilization: 5, resets_at: '2026-08-13T18:00:00Z' },
    seven_day: { utilization: 0, resets_at: null }
  };
  const weeklyOnly = {
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 18, resets_at: '2026-08-19T09:00:00Z' }
  };

  assert.strictEqual(isEmptyUsagePayload(sessionOnly), false);
  assert.strictEqual(isEmptyUsagePayload(weeklyOnly), false, 'session non démarrée mais semaine en cours');
});

test('un payload tronqué ou absent ne fait pas lever', () => {
  assert.strictEqual(isEmptyUsagePayload({}), true);
  assert.strictEqual(isEmptyUsagePayload(null), true);
  assert.strictEqual(isEmptyUsagePayload(undefined), true);
  assert.strictEqual(isEmptyUsagePayload({ five_hour: null, seven_day: null }), true);
});

// --- Faut-il incriminer l'organisation ? ----------------------------------

test('sans historique sur l\'org et avec une alternative, on incrimine l\'org', () => {
  assert.strictEqual(
    looksLikeWrongOrg({ emptyPayload: true, orgHasHistory: false, chatOrgCount: 2 }),
    true
  );
});

// Cas relevé le 13/08 sur le compte concerné : son offre ne rapporte jamais de
// fenêtre seven_day (null, pas zéro), donc tout matin avant le premier message
// ressemble à un payload vide. Un avertissement quotidien sur une
// configuration saine serait du bruit — l'historique de l'org le dément.
test('une org qui a produit de l\'usage récemment est inactive, pas fautive', () => {
  assert.strictEqual(
    looksLikeWrongOrg({ emptyPayload: true, orgHasHistory: true, chatOrgCount: 2 }),
    false
  );
});

test('sans autre organisation, on n\'incrimine rien — il n\'y a pas de remède', () => {
  assert.strictEqual(
    looksLikeWrongOrg({ emptyPayload: true, orgHasHistory: false, chatOrgCount: 1 }),
    false
  );
  assert.strictEqual(
    looksLikeWrongOrg({ emptyPayload: true, orgHasHistory: false, chatOrgCount: 0 }),
    false
  );
});

test('un payload exploitable ne déclenche jamais l\'avertissement', () => {
  assert.strictEqual(
    looksLikeWrongOrg({ emptyPayload: false, orgHasHistory: false, chatOrgCount: 5 }),
    false
  );
});
