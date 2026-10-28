# Atelier de brisage

Outil de rentabilité du craft et du brisage pour **Dofus 3**, à partager entre amis.

- **Toutes les recettes de Dofus 3 (4 743)** : équipements, trophées, prysmaradites, potions, nourriture, ressources transformées, objets de quête, idoles, apparat… extraites des fichiers du jeu et mises à jour chaque semaine par GitHub.
- **Catalogue** : tout ce qui se fabrique, avec filtres par catégorie, type, métier et niveau, et la recette de chaque objet.
- **Mes kamas** (page d'accueil) : 1. les kamas que j'engage → 2. mon panier (je cherche un item, je choisis le moyen et la quantité, l'outil calcule ce que j'engage et ce que je gagne, puis « Lancer le panier ») avec des idées si besoin → 3. ce qui est en cours → 4. mon bénéfice.
- **Opportunités** : pour chaque item suivi, la meilleure des 4 options (crafter ou acheter, puis briser ou revendre), avec un indice de fiabilité. Le plan pour ton budget est dans « Mes kamas › Des idées ? ».
- **Prix du marché** : tous tes prix au même endroit (ressources, runes, items), avec les prix proposés par ton groupe.
- **Mes séries** : chaque série, de l'achat à la vente, avec un bouton par étape : Brisé, Mettre en vente / Baisser le prix (la taxe HDV est repayée à chaque fois et ajoutée au coût), Vendu… (combien, à quel prix, date et heure : les ventes partielles sont gérées).
- **Résultats** : bénéfice par jour, semaine, mois ou année, rendement réel par item, calendrier d'activité et alertes. Le bénéfice ne compte que les kamas encaissés ; des runes pas encore vendues restent « en cours ».
- **Familiers** : XP à donner selon la courbe officielle, et la ressource la moins chère pour 1 000 XP (XP par ressource partagées dans le groupe).
- **Le groupe** : chacun a son profil et voit les bilans et le journal des autres, en lecture seule.

Le site est hébergé gratuitement sur **GitHub Pages**. Les données (profils, prix, journaux) sont stockées dans **Firebase**, gratuit pour un groupe d'amis.

---

## Installation (environ 20 minutes, une seule fois)

### 1. Mettre le projet sur GitHub

1. Crée un compte sur [github.com](https://github.com) si tu n'en as pas.
2. Clique sur **New repository**. Nom : `atelier-brisage`, visibilité **Public** (obligatoire pour GitHub Pages gratuit). Ne coche rien d'autre, puis **Create repository**.
3. Envoie les fichiers de ce dossier :
   - **Sans logiciel** : sur la page du dépôt, clique sur *uploading an existing file*, glisse **tout le contenu** du dossier (pas le dossier lui-même), puis **Commit changes**.
     Attention : le dossier `.github` est caché sous Windows. Affiche-le (Explorateur > Affichage > Éléments masqués) pour l'inclure, sinon la mise à jour automatique des recettes ne marchera pas.
   - **Avec Git** (recommandé, pour l'avoir aussi sur ton PC) :
     ```bash
     cd atelier-brisage
     git init
     git add .
     git commit -m "Atelier de brisage"
     git branch -M main
     git remote add origin https://github.com/TON-PSEUDO/atelier-brisage.git
     git push -u origin main
     ```
4. **Settings > Pages** : *Source* = **Deploy from a branch**, *Branch* = `main` / `/ (root)`, puis **Save**.
   Après une minute, le site est en ligne sur `https://TON-PSEUDO.github.io/atelier-brisage/`.
5. **Settings > Actions > General > Workflow permissions** : coche **Read and write permissions**, puis **Save**. C'est ce qui permet la mise à jour automatique des recettes.

### 2. Créer la base Firebase

1. Va sur [console.firebase.google.com](https://console.firebase.google.com), puis **Créer un projet** (nom libre, Google Analytics inutile).
2. **Ajouter une application > Web** (icône `</>`), nom libre, sans hébergement Firebase.
   Firebase affiche un bloc `firebaseConfig`. Copie ses valeurs dans **`js/firebase-config.js`** à la place des `A_REMPLIR`.
3. **Build > Authentication > Commencer > Google > Activer**, choisis ton email d'assistance, puis **Enregistrer**.
4. Toujours dans Authentication, onglet **Paramètres > Domaines autorisés > Ajouter un domaine** : `TON-PSEUDO.github.io`.
5. **Build > Firestore Database > Créer une base de données**. Emplacement : `eur3 (europe-west)`. Mode : **production**.
6. Onglet **Règles** de Firestore : ouvre `firestore.rules`, remplace `CODE_DU_GROUPE` par un code secret de ton choix (par ex. `brisage-k7q2`), colle tout le fichier, puis **Publier**.
7. Envoie la nouvelle version de `js/firebase-config.js` sur GitHub (upload ou `git commit` + `git push`).

> Les clés de `firebase-config.js` ne sont pas secrètes, c'est normal qu'elles soient publiques. La sécurité vient des règles : sans le **code du groupe**, personne ne peut créer de profil ni lire vos données.

### 3. Premier lancement

1. Ouvre `https://TON-PSEUDO.github.io/atelier-brisage/`, connecte-toi avec Google, choisis ton pseudo et saisis le code du groupe.
2. Pour retrouver tes 13 items de départ : **Mes données > Importer**, puis choisis `data/depart-tanguy.json` (dans le dossier du projet sur ton PC).
3. Renseigne les prix dans **Prix des ressources**. Les rendements apparaissent dans **Crafts suivis**.

### 4. Inviter tes copains

Envoie-leur l'adresse du site et le code du groupe. Chacun se connecte avec son compte Google et crée son profil. Ensuite :
- l'onglet **Le groupe** compare les bilans de tous ;
- le menu **Profil affiché** ouvre le tableau de bord, les crafts et le journal d'un membre, en lecture seule ;
- chacun a ses propres prix de ressources.

Pour retirer quelqu'un : Firebase > Firestore > `profiles` > supprime son document. Pour fermer les inscriptions : change le code dans les règles et republie-les.

---

## Comment le brisage est estimé

Pour chaque effet de l'item (tiré des fichiers du jeu), l'outil prend le jet moyen et applique la formule communautaire :

```
runes de base = (jet moyen × poids de la caractéristique × niveau × 0,015 + 1) × coefficient ÷ poids d'une rune de base
```

Le poids d'une rune de base vaut « points apportés par la rune × poids de la caractéristique » (par exemple 5 points pour une rune Vitalité). La valeur du brisage est la somme des runes multipliées par leur prix, moins la taxe HDV.

C'est une **estimation** : la formule n'est pas publiée par Ankama, le jet réel de ton item varie, et l'outil compte tout en runes de base. Il n'y a **pas de coefficient par défaut** : tant que tu n'as pas saisi le coefficient affiché en jeu, l'outil n'estime pas le brisage de l'item. Si tu connais la vraie valeur de brisage, tape-la : elle remplace l'estimation.

## Raccourcis clavier

| Touche | Action |
|---|---|
| `Tab` ou `Entrée` | Case suivante dans la même colonne |
| `Maj` + `Tab` | Case précédente dans la même colonne |
| `↑` `↓` | Monter ou descendre dans une colonne de nombres |
| `1` à `5` | Changer d'onglet |
| `/` | Chercher un item à suivre |
| `N` | Nouvelle série dans le journal |
| `?` | Aide des raccourcis |
| Clic sur un titre de colonne | Trier (un 2e clic inverse l'ordre) |

## Utiliser l'outil sur ton PC

Le site en ligne suffit. Si tu veux l'ouvrir en local (pour le modifier, par exemple), il faut un petit serveur, car Google refuse la connexion depuis un fichier ouvert directement :

```bash
cd atelier-brisage
python -m http.server 8000
```

Puis ouvre `http://localhost:8000`. `localhost` est autorisé par défaut dans Firebase.

## Mise à jour automatique des recettes

Le fichier `.github/workflows/maj-recettes.yml` tourne chaque mercredi matin sur GitHub :
1. il télécharge la base Dofus 3 du projet [ledouxm/dofus-sqlite](https://github.com/ledouxm/dofus-sqlite), mise à jour toutes les heures à partir des fichiers du jeu ;
2. il régénère `data/recettes.json` avec `scripts/maj_recettes.py` ;
3. il enregistre le fichier seulement si des recettes ont changé. Le message du commit indique combien ont été ajoutées, supprimées ou modifiées.

Pour le lancer à la main : onglet **Actions > Mise à jour des recettes Dofus 3 > Run workflow**.
Si l'extraction paraît anormale (moins de 4 000 recettes), rien n'est modifié et l'action apparaît en échec.

Quand tu modifies une recette à la main dans l'outil (quantité, ingrédient retiré), ta version est gardée dans ton profil. Le bouton « Revenir à la recette du jeu » reprend celle du fichier.

## Structure

```
index.html                 la page
css/style.css              les styles (thème clair et sombre)
js/app.js                  toute la logique
js/firebase-config.js      ta configuration Firebase (à remplir)
data/recettes.json         recettes Dofus 3 (mis à jour par GitHub)
data/depart-tanguy.json    les 13 items de départ, à importer
firestore.rules            règles de sécurité à coller dans Firebase
scripts/maj_recettes.py    extraction des recettes
.github/workflows/         mise à jour hebdomadaire automatique
```

## Limites

- Les ventes ne sont pas récupérées depuis le jeu : Ankama ne propose pas d'accès officiel à ces données, et les outils qui lisent le trafic du jeu sont interdits. On saisit donc les ventes à la main dans le journal.
- Les recettes dépendent du projet dofus-sqlite. S'il s'arrête, l'action échoue sans rien casser : l'outil garde les dernières recettes connues.

## Données et licences

- Recettes, effets et courbe d'XP des familiers : fichiers du jeu Dofus 3, via [dofus-sqlite](https://github.com/ledouxm/dofus-sqlite). Dofus est une marque d'Ankama.
- XP des ressources pour les familiers (`data/xp-table.json`) : [Dofus Wiki – Pet experience table](https://dofuswiki.fandom.com/wiki/Pet_experience_table), sous licence [CC BY-SA](https://creativecommons.org/licenses/by-sa/3.0/). Ce fichier est redistribué sous la même licence.
