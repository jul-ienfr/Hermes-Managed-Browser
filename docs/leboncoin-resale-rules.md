# Leboncoin Resale Rules

Module local de décision pour l'achat-revente supervisé sur Leboncoin.

Il sert à scorer une annonce observée dans le navigateur, pas à collecter Leboncoin via API.

## Règles non négociables

- Navigation Leboncoin uniquement via navigateur/VNC normal.
- Aucune API Leboncoin directe.
- Aucun endpoint caché.
- Aucun scraping d'API interne.
- Aucun achat autonome.
- Aucun paiement autonome.
- Aucun envoi de données personnelles sans validation.
- Les profils navigateur existants ne sont pas créés, modifiés ou supprimés par ce module.

Ces garanties sont dans `leboncoin-resale.config.json` :

```json
{
  "mode": "supervised_browser_only",
  "browserPolicy": {
    "browserOnly": true,
    "forbidDirectLeboncoinApi": true,
    "forbidHiddenEndpoints": true,
    "forbidInternalApiScraping": true,
    "allowedCollectionMode": "manual_vnc_observation"
  },
  "supervision": {
    "requireValidationBeforeMessage": true,
    "requireValidationBeforePurchase": true,
    "allowAutonomousPurchase": false,
    "allowAutonomousPayment": false,
    "allowAutonomousPersonalDataSharing": false
  }
}
```

## Fichiers

- `leboncoin-resale.config.json` : paramètres éditables.
- `lib/leboncoin-resale-rules.js` : validation, scoring, prix rentable, contre-offres.
- `tests/unit/leboncoinResaleRules.test.js` : tests unitaires.

## Phase 1 : petits objets uniquement

Règle métier : petit, liquide, revendable vite.

À privilégier :

- consoles / manettes / jeux
- smartphones / tablettes
- écouteurs/casques vérifiables
- petits outils électroportatifs
- batteries/chargeurs/outillage compact
- petits accessoires photo/audio/informatique
- babyphones / petits articles premium

À exclure au départ :

- meubles
- gros électroménager
- vélos adultes
- gros lots encombrants
- poussettes volumineuses sauf Yoyo/Cybex très rentable
- TV grandes tailles
- objets fragiles/grands à expédier

Implémentation :

```json
{
  "storage": {
    "phase": 1,
    "maxBulkiness": "small",
    "maxFragility": "medium",
    "maxStorageDays": 21,
    "smallObjectsOnly": true,
    "fitRule": "must_fit_closet_shelf_or_car_trunk"
  }
}
```

## Marges

Le module applique à la fois :

1. un pourcentage de marge brute minimum ;
2. un profit net minimum par tranche de prix ;
3. un plafond d'achat dur.

```json
{
  "margins": {
    "minGrossMarginPercent": 30,
    "targetGrossMarginPercent": 50,
    "netProfitByPurchaseBand": [
      { "maxPrice": 50, "minNetProfit": 20 },
      { "maxPrice": 150, "minNetProfit": 40 },
      { "maxPrice": 250, "minNetProfit": 70 },
      { "maxPrice": null, "minNetProfit": 120 }
    ]
  }
}
```

## Score

Formule métier :

```text
score = marge + demande + vitesse revente
        - risque panne/arnaque
        - distance
        - encombrement
        - fragilité
        - temps de stockage probable
```

Dans le fichier JSON, les poids sont positifs et les facteurs négatifs sont inversés dans le code : risque bas = meilleur score, distance basse = meilleur score, etc.

Décisions :

- `buy_direct` : annonce excellente, ne pas perdre de temps à négocier.
- `negotiate` : bonne annonce, négociation standard.
- `watch` : surveiller / garder en favori.
- `aggressive_negotiation` : trop chère mais ancienne, offre forte possible.
- `ignore` : rejet.

## Règle annonce trop chère mais ancienne

Si une annonce est trop chère mais ancienne, elle n'est pas ignorée directement.

Le module calcule :

- `profitableMaxOffer` : prix maximum rentable ;
- `openingOffer` : première offre agressive ;
- `abandonIfCounterAbove` : plafond à ne pas dépasser.

Exemple :

```json
{
  "decision": "aggressive_negotiation",
  "reason": "overpriced_but_stale",
  "profitableMaxOffer": 225,
  "openingOffer": 180,
  "abandonIfCounterAbove": 225
}
```

Règle : si la contre-offre vendeur dépasse `abandonIfCounterAbove`, abandon immédiat.

## Achat direct sans négociation

Si le deal est déjà excellent :

- marge nette forte ;
- pourcentage de marge fort ;
- risque faible ;
- objet petit et liquide ;

alors décision `buy_direct`, avec message au prix affiché.

## Exemple d'utilisation

```js
import {
  scoreLeboncoinListing,
  evaluateLeboncoinCounterOffer,
} from './lib/leboncoin-resale-rules.js';

const decision = scoreLeboncoinListing({
  category: 'video_games',
  price: 70,
  estimatedResalePrice: 125,
  distanceKm: 5,
  bulkiness: 'small',
  fragility: 'medium',
  expectedStorageDays: 7,
  demandScore: 0.9,
  resaleSpeedScore: 0.8,
  riskScore: 0.2,
  ageDays: 3,
  attributes: [],
});

const counter = evaluateLeboncoinCounterOffer({
  category: 'video_games',
  price: 140,
  estimatedResalePrice: 150,
}, 112);
```

## Tests

```bash
npm test -- tests/unit/leboncoinResaleRules.test.js --runInBand
node --check lib/leboncoin-resale-rules.js
node -e "JSON.parse(require('fs').readFileSync('leboncoin-resale.config.json','utf8')); console.log('json ok')"
```
