# Plan — rafraîchissement automatique, multi-compte, sonde d'usage

> **Statut : plan, pas backlog.** Aucune tâche n'est prenable en l'état. Le découpage en
> tâches atomiques se fait lot par lot, par `/cadrer`, **au moment d'ouvrir le lot** — un lot
> pas encore ouvert ne se découpe pas (règle 7 de `regles-dev.md`).
>
> - Rédigé le **2026-08-05**, à partir d'une étude sur code et sur disque (voir « Constats »).
> - Périmètre de sécurité : **P0** (poste isolé).
> - Dépôt : `claude-usage-widget-integrated` (git, v1.7.5).
> - **Rien n'a été écrit dans `C:\DEV\claude-kit` pour le moment.** Le lot K1 ci-dessous
>   concerne le kit : il sera transcrit dans le `PLAN.md` du kit le jour où il sera ouvert.
>   Ne pas écraser ce `PLAN.md`-là, il porte un backlog vivant de 8 102 lignes piloté par
>   `boucle-dev.py`.

---

## 1. Le besoin, en deux phrases

1. La `sessionKey` du compte pro est renouvelée toutes les 24 h par la politique de
   l'organisation ; le widget ne sait que la redemander à la main.
2. Un compte perso est utilisé en complément, en alternance avec le pro, pour finir des tâches
   sur les crédits restants — ce que le widget ne sait pas représenter.

Et un troisième besoin découvert en cours d'étude : **le claude-kit ne connaît pas les quotas
réels**. Il les estime par une question à quatre tranches posée à l'humain.

---

## 2. Constats vérifiés

> Ces constats sont **mesurés**, pas supposés. Ils sont la partie la plus coûteuse à
> reconstituer d'une session à l'autre : ne pas les réécrire sans nouvelle mesure.

### 2.1 Le widget écrase activement les rotations de cookie

`main.js:1275` réécrit le cookie depuis le magasin **avant chaque fetch**. Quand claude.ai
renvoie une `sessionKey` rafraîchie via `Set-Cookie`, le pot de cookies Electron l'enregistre,
puis le fetch suivant remet l'ancienne valeur par-dessus. Le renouvellement silencieux qui
pourrait déjà fonctionner est annulé à chaque tour. **C'est le constat central.**

### 2.2 « Log Out » ne supprime pas la clé stockée

`main.js:597` et `main.js:1334` font `store.delete('sessionKey')`. Or le magasin sur disque
(`%APPDATA%\claude-usage-widget\config.json`) contient **`sessionKey_encrypted`**, et **pas**
`sessionKey` — `safeStorage` est disponible sous Windows, donc c'est la variante chiffrée qui
est utilisée. Ces suppressions ne suppriment rien.

Conséquence enchaînée : `main.js:1425` réinjecte la clé au démarrage suivant. **Après un logout
puis un redémarrage, le cookie de l'ancien compte revient.** Piste sérieuse pour toute
instabilité ressentie lors des bascules.

### 2.3 Aucun code HTTP n'est lu

`src/fetch-via-window.js` lit `document.body.innerText` et renifle le corps
(`BLOCKED_SIGNATURES`). Le statut HTTP n'est jamais consulté. Si l'API répond 401 avec un corps
JSON, il traverse `parseResponseBody` et est traité comme des données d'usage. L'expiration
n'est détectée que quand Cloudflare renvoie du HTML.

*Voie de correction connue* : `did-navigate` expose `httpResponseCode` en troisième argument.

### 2.4 La fenêtre de login efface le cookie avant de s'ouvrir

`main.js:1097` supprime la `sessionKey` **avant** d'ouvrir la fenêtre, forçant une
ré-authentification complète même quand la session claude.ai est encore vivante.

### 2.5 `expirationDate` est jetée à la capture

`main.js:1166` ne conserve que `cookie.value`. Sans la date d'expiration, impossible
d'anticiper : on ne peut que réagir à la panne.

### 2.6 Le magasin est mono-compte, sauf l'historique

Relevé sur disque le 2026-08-05 :

| Clé | Contenu | Multi-compte ? |
|---|---|---|
| `usageHistory_<uuid-organisation-1>` | 2 022 points | ✅ indexée par organisation (`main.js:74`) |
| `usageHistory_<uuid-organisation-2>` | 17 points | ✅ idem |
| `sessionKey_encrypted` | chaîne | ❌ un seul emplacement |
| `organizationId` | chaîne | ❌ un seul emplacement |
| `latestUsageData` | objet | ❌ un seul emplacement (`main.js:1390`) |

Les deux comptes ont donc déjà laissé leur trace, et **seul l'historique survit** aux bascules.

### 2.7 Le pot de cookies est unique, et le logout détruit la session de l'IdP

Tout passe par `session.defaultSession` : les deux comptes ne peuvent pas coexister, d'où
l'obligation de se déconnecter pour basculer. `main.js:604` fait en plus un
`clearStorageData` sur `localstorage`/`sessionstorage` → la session de l'IdP part avec, et
chaque retour au compte pro repasse par le MFA complet. **Cette partie est auto-infligée**,
elle ne découle pas de la politique de l'établissement.

*Voie de correction connue* : `session.fromPartition('persist:<profil>')`, deux pots étanches.

### 2.8 Le kit devine les quotas — et le widget les connaît

`claude-kit/devsecops-pipeline/commands/avancer.md:75-85` pose une question à quatre tranches
dont la réponse devient `--restant-pct 85 --restant-minutes 250`. Une estimation à l'œil, qui
alimente un `planifier-lot.py` par ailleurs rigoureux (il mesure la durée d'une tâche sur le
`boucle.log` réel, puis la multiplie par cette devinette).

Deux autres aveuglements du même ordre, côté kit :

- `boucle-dev.py:94` — `RE_QUOTA` détecte l'épuisement **après coup**, par expression
  régulière sur la sortie du modèle. Une tâche meurt en cours, puis 20 min de sommeil, puis on
  retente à l'aveugle.
- `REPOS_PAR_CAUSE` (`superviseur-boucle.py`) — repos forfaitaires, faute de savoir quand la
  fenêtre repart.

Or le widget dépose déjà sur disque, en JSON clair, rafraîchi à son intervalle (300 s par
défaut) :

```json
"five_hour": { "utilization": 8, "resets_at": "2026-08-05T23:09:59.032299+00:00" }
```

| Entrée du kit | Aujourd'hui | Disponible dans `latestUsageData` |
|---|---|---|
| `--restant-pct` | tranche « 85 » | `100 - utilization` = **92** |
| `--restant-minutes` | tranche « 250 » | `resets_at − maintenant`, exact |
| repos du superviseur | forfait 20 min | réveil **à** `resets_at` |

Champs présents dans `latestUsageData` : `five_hour`, `seven_day`, `seven_day_opus`,
`seven_day_sonnet`, `seven_day_cowork`, `seven_day_oauth_apps`, `extra_usage`, `limits`,
`spend`, `member_dashboard_available`, et divers champs à noms de code.

Forme d'un point d'historique : `{timestamp, session, weekly, sonnet, opus, cowork, design,
oauthApps, extraUsage}`.

---

## 3. La contrainte qui écarte la solution évidente

Ce widget existe **parce que** le fetch HTTP simple est bloqué par Cloudflare — c'est écrit en
tête de `src/fetch-via-window.js`, avec la mention que la stratégie précédente (lire la base de
cookies du navigateur) s'était révélée « trop fragile et spécifique à l'OS ».

**Python ne peut pas reproduire ça.** Porter le fetch dans le kit reviendrait à réécrire la
partie fragile et à se rebattre contre Cloudflare. Options classées :

| | Approche | Verdict |
|---|---|---|
| a | le kit **lit** `config.json` du widget | ✅ zéro auth, zéro Cloudflare, faisable vite |
| b | le widget écrit un `usage.json` dédié à chaque fetch | ✅ le contrat durable, schéma stable |
| c | porter le fetch en Python (playwright, pywebview…) | ❌ nouvelle dépendance, duplique le fragile |

**Retenu : (a) pour prouver la valeur, (b) pour la garder.** Réserve sur (a) : c'est un
couplage au schéma interne de ce projet, donc à isoler côté kit dans **un seul module
adaptateur** — une mise à jour du widget doit casser un fichier, pas le kit.

---

## 4. Les lots

Ordre imposé par les dépendances techniques, pas par la valeur. Le lot K1 rend service seul, et
sans toucher au widget : il est le bon candidat si on veut un résultat visible d'abord.

### Lot W1 — Corriger les trois dysfonctionnements confirmés

Constats 2.1, 2.2, 2.3. Utile dans tous les cas, indépendant du reste.

> **Recette** : je me déconnecte, je redémarre le widget, et il me redemande de me connecter —
> il ne repart pas sur l'ancien compte.

### Lot W2 — Profils étanches (pro / perso)

Constats 2.6, 2.7. Une partition Electron par profil, un jeu de clés par profil, bascule sans
déconnexion. Débloque W3 et K1.

> **Recette** : je passe du compte pro au compte perso et j'en reviens sans repasser par
> l'authentification de l'établissement, et chaque compte affiche ses propres chiffres.

### Lot W3 — Cascade de rafraîchissement automatique, par profil

Constats 2.4, 2.5. Quatre niveaux, du moins au plus intrusif :

| Niveau | Mécanisme | Visible ? |
|---|---|---|
| 1 | **Capture passive** — écouteur `cookies.on('changed')` permanent qui persiste toute nouvelle valeur ; `setSessionCookie` ne réécrit que si la valeur diffère | non |
| 2 | **Anticipation** — `expirationDate` stockée, niveau 3 déclenché vers 90 % de la durée de vie | non |
| 3 | **Rafraîchissement silencieux** — fenêtre cachée sur claude.ai ; si la session de l'IdP est vivante, la redirection repose une clé fraîche qu'on capture. Abandon sur délai ou sur apparition d'une page de saisie | non |
| 4 | **Repli interactif** — la fenêtre de login actuelle, sans effacer le cookie d'abord, déclenchée une seule fois | oui |

La politique de rafraîchissement est **par profil** : les 24 h sont la contrainte du compte
pro, il n'y a pas lieu de les infliger au compte perso.

> **Recette** : le widget continue d'afficher mes chiffres le lendemain matin sans que j'aie
> eu à ressaisir quoi que ce soit — ou, si mon organisation l'exige, il me le demande une fois,
> au moment où ça expire, sans rester muet.

### Lot K1 — Sonde d'usage lue par le kit *(travaux côté `claude-kit`)*

Un module adaptateur qui rend `{restant_pct, restant_minutes, resets_at, profil}`. Points de
consommation, par ordre de gain décroissant :

1. `superviseur-boucle.py` — se réveiller **à** `resets_at` au lieu du forfait. Le plus gros
   gain : aujourd'hui la cause `quota` dort 20 min et retente en boucle.
2. `planifier-lot.py` — `--restant-pct` réel. **Garder le drapeau manuel** comme repli (widget
   éteint, données périmées) et comme surcharge.
3. `boucle-dev.py` — **ne pas démarrer** une tâche si le quota restant ne couvre pas la durée
   médiane mesurée. Évite la tâche à moitié écrite laissée en `[>]`.
4. `/avancer` étape 1 — une question sur deux disparaît. **La seconde reste** : le nombre de
   projets en parallèle n'est pas dans l'API.
5. `tableau-bord.py` — l'usage réel à côté de l'état de la boucle.

> **Recette** : `/avancer` m'annonce la taille du lot sans me demander où en est ma fenêtre de
> 5 h, et le chiffre qu'il utilise correspond à ce qu'affiche le widget.

---

## 5. Là où les lots se croisent

Quand on bascule sur le compte perso pour finir des tâches, **le modèle de budget de la boucle
doit suivre**. Un `latestUsageData` mono-emplacement lui ferait dimensionner un lot sur le
quota du compte qu'elle vient de quitter.

C'est l'argument décisif pour que l'instantané exposé au kit soit **indexé par profil** — donc
**W2 est un prérequis de K1**, et pas une option indépendante. Si K1 est ouvert avant W2, il
doit au minimum publier l'identifiant d'organisation avec les chiffres, pour que le kit puisse
refuser de planifier sur des données dont il n'est pas sûr de la provenance.

---

## 6. Piège à ne pas commettre

`mesurer-couts.py` (kit) mesure un **coût en dollars depuis les transcripts**. Ce widget mesure
une **consommation de quota depuis l'API**. Ce sont deux grandeurs différentes : ne pas
substituer l'une à l'autre. Les croiser calibrerait en revanche la conversion « % → nombre de
tâches » de `planifier-lot.py`, qui repose aujourd'hui sur un `FENETRE_MINUTES / durée` fixe.

---

## 7. Contraintes à tenir (P0)

- La clé reste chiffrée par `safeStorage`, jamais en clair dans le magasin.
- **Aucun secret dans les logs.** À corriger au passage : `main.js:859` journalise les
  20 premiers caractères de la clé.
- La navigation reste bornée à la liste blanche de domaines existante (`allowedLoginDomains`).
- Ce dépôt étant un vrai dépôt git, une branche sert de filet — `checkpoint.py` ne s'applique
  pas ici. Le kit, lui, n'est pas un dépôt : point de restauration avant toute modification
  côté K1.
- Rien de ce plan ne contourne une politique d'authentification. Si l'IdP exige une
  ré-authentification interactive, le niveau 3 échoue par conception et le niveau 4 prend le
  relais.

---

## 8. Mesure préalable, avant d'ouvrir W3

**À faire avant de découper W3, et seulement pour W3.** Le niveau 3 de la cascade dépend d'un
fait inconnu : la `sessionKey` expire-t-elle seule (session IdP encore vivante →
rafraîchissement silencieux possible), ou l'organisation impose-t-elle une ré-authentification
interactive (MFA, accès conditionnel → seul le niveau 4 est atteignable) ?

À relever : l'`expirationDate` réelle du cookie, et le comportement observé à l'expiration
(corps et statut de la réponse, présence ou non d'une redirection vers l'IdP).

Écrire les niveaux 2 et 3 sans cette mesure, c'est risquer de les écrire pour rien. W1, W2 et
K1 n'en dépendent pas.

---

## Décidé en autonomie

- **2026-08-05** — Lecture du `config.json` du widget (option a) retenue plutôt qu'un portage
  du fetch en Python (option c) : Cloudflare bloque le fetch simple, c'est la raison d'être de
  la `BrowserWindow` de ce projet.
- **2026-08-05** — Ordre des lots fixé par les dépendances techniques (W2 avant K1), la valeur
  d'usage plaçant pourtant K1 en premier. Arbitrage assumé : K1 seul reste possible s'il
  publie l'identifiant d'organisation avec ses chiffres.

## Questions ouvertes

- **Faut-il interroger les deux comptes en permanence, ou seulement le profil actif ?** Les
  interroger tous les deux permet d'afficher les deux soldes côte à côte — précisément ce qu'on
  veut au moment de décider si on finit sur les crédits perso. Coût : une fenêtre cachée de
  plus par cycle. À trancher à l'ouverture de W2.
- **Le compte perso a-t-il, lui aussi, une expiration courte ?** À relever en même temps que la
  mesure du §8.
