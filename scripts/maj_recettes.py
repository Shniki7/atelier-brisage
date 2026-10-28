"""Extrait TOUTES les recettes Dofus 3 (équipements, consommables, ressources, objets de quête, apparat) depuis la base dofus-sqlite
(https://github.com/ledouxm/dofus-sqlite) et écrit data/recettes.json.

Usage : python3 scripts/maj_recettes.py dofus.sqlite itemsdata.json data/recettes.json
(itemsdata.json vient de la même release et contient les effets des objets)
Sort en erreur (code 1) si l'extraction paraît anormale : rien n'est alors écrit.
"""
import sqlite3, json, sys, datetime, re

src, fx_src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
c = sqlite3.connect(src)
T = dict(c.execute("select id,value from translations where lang='fr'").fetchall())
TEN = dict(c.execute("select id,value from translations where lang='en'").fetchall())

def nm(nid):
    try:
        return T.get(int(nid))
    except (TypeError, ValueError):
        return None

I = {r[0]: r for r in c.execute(
    "select id,nameId,typeId,level from ItemData union all select id,nameId,typeId,level from WeaponData")}
Ty = {r[0]: (r[1], r[2]) for r in c.execute("select id,nameId,categoryId from ItemTypeData")}
J = {r[0]: nm(r[1]) for r in c.execute("select id,nameId from JobData")}
ing = {}
for rid, tid in c.execute("select RecipeData_id,target_id from RecipeData_ingredientIds_junction order by rowid"):
    ing.setdefault(rid, []).append(tid)

# catégories du jeu (ItemTypeData.categoryId)
CATS = {0: 'Équipements', 1: 'Consommables', 2: 'Ressources', 3: 'Quêtes et idoles', 5: 'Apparat'}
items, res, types, tcat, incoherences = [], {}, {}, {}, 0
for uid, resid, q, job in c.execute("select id,resultId,quantities,jobId from RecipeData"):
    it = I.get(resid)
    if not it:
        continue
    ty = Ty.get(it[2])
    if not ty:
        continue
    tn = nm(ty[0]) or ''
    n = nm(it[1])
    if not n:
        continue
    q = json.loads(q)
    ids = ing.get(uid, [])
    if len(q) != len(ids):
        incoherences += 1
        continue
    types[it[2]] = tn
    tcat[it[2]] = ty[1]
    for i in ids:
        res[i] = (nm(I[i][1]) if i in I else None) or str(i)
    items.append([resid, n, it[3], it[2], J.get(job, '') or '', [[i, x] for i, x in zip(ids, q)]])

items.sort(key=lambda x: x[1])

# ---- effets des objets (pour estimer le brisage) ----
# EffectData : effectPowerRate = poids de la caractéristique, bonusType 1 = bonus
E = {r[0]: r[1:] for r in c.execute("select id,descriptionId,effectPowerRate,bonusType,characteristic from EffectData")}
def stat_name(a):
    s = T.get(int(E[a][0]), '') if a in E else ''
    return re.sub(r'#\d|\{\{.*?\}\}', '', s).strip()
# points apportés par une rune de base (Ba) : 1 sauf pour les caractéristiques très légères
PTS = {'Vitalité': 5, 'Initiative': 10, 'Pod': 10}
raw = json.load(open(fx_src, encoding='utf-8'))
refs = raw['references']['RefIds']
by_rid = {r['rid']: r['data'] for r in refs}
wanted = {i[0] for i in items}
fx, stats = {}, {}
for r in refs:
    if r['type']['class'] not in ('ItemData', 'WeaponData'):
        continue
    iid = r['data'].get('id')
    if iid not in wanted:
        continue
    lines = []
    for e in r['data'].get('possibleEffects', {}).get('Array', []):
        x = by_rid.get(e['rid'])
        if not x:
            continue
        a = x['actionId']
        if a not in E or E[a][2] != 1 or not E[a][1] or E[a][1] <= 0 or E[a][3] <= 0:
            continue
        lo = x.get('diceNum', 0) or 0
        hi = x.get('diceSide', 0) or 0
        if hi < lo:
            hi = lo
        if hi <= 0:
            continue
        sn = stat_name(a)
        stats[str(a)] = [sn, E[a][1], PTS.get(sn, 1)]
        lines.append([a, lo, hi])
    if lines:
        fx[str(iid)] = lines
print(f"objets avec effets={len(fx)} caracteristiques={len(stats)}")
print(f"items={len(items)} ressources={len(res)} incoherences={incoherences}")
if len(items) < 4000 or incoherences > 80 or len(fx) < 2000:
    print("Extraction anormale : data/recettes.json n'est pas modifié.")
    sys.exit(1)

# ---- familiers : toutes les ressources (pour le tableau d'XP), courbe d'XP des familiers ----
allres, allres_en = {}, {}
for iid, nid, tid, lvl in I.values():
    ty = Ty.get(tid)
    if not ty or ty[1] != 2:          # catégorie 2 = ressources
        continue
    n = nm(nid)
    if n and not n.startswith('Cadeau'):
        allres[str(iid)] = n
        try:
            en = TEN.get(int(nid))
        except (TypeError, ValueError):
            en = None
        if en:
            allres_en[str(iid)] = en
curve = c.execute("select experienceByLevel from EvolutiveItemTypeData where id=1").fetchone()
petcurve = json.loads(curve[0]) if curve else []
# XP par unité relevées dans des guides communautaires (à confirmer en jeu)
# (les anciennes valeurs des guides Dofus 2 sont dépassées : on ne garde que la croquette, sûre)
GUIDE_XP = {'Croquette enrichie': 500}
by_name = {v: k for k, v in allres.items()}
petxp = {by_name[n]: x for n, x in GUIDE_XP.items() if n in by_name}
print(f"ressources={len(allres)} courbe={len(petcurve)} xp_guides={len(petxp)}")

d = {
    'src': 'Dofus 3 (dofus-sqlite, ' + datetime.date.today().strftime('%d/%m/%Y') + ')',
    'types': {str(k): v for k, v in types.items()},
    'tcat': {str(k): v for k, v in tcat.items()},
    'cats': {str(k): v for k, v in CATS.items()},
    'res': {str(k): v for k, v in res.items()},
    'items': items,
    'fx': fx,
    'stats': stats,
    'allres': allres,
    'allres_en': allres_en,
    'petcurve': petcurve,
    'petxp': petxp,
}
with open(dst, 'w', encoding='utf-8') as f:
    f.write(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
