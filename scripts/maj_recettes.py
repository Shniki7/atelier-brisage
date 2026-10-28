"""Extrait les recettes d'équipements Dofus 3 depuis la base dofus-sqlite
(https://github.com/ledouxm/dofus-sqlite) et écrit data/recettes.json.

Usage : python3 scripts/maj_recettes.py dofus.sqlite data/recettes.json
Sort en erreur (code 1) si l'extraction paraît anormale : rien n'est alors écrit.
"""
import sqlite3, json, sys, datetime

src, dst = sys.argv[1], sys.argv[2]
c = sqlite3.connect(src)
T = dict(c.execute("select id,value from translations where lang='fr'").fetchall())

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

EXCLUS = ('Outil', 'Pelle', 'Pioche', "Pierre d'âme", 'Filet de capture', 'Trophée', 'Prysmaradite')
items, res, types, incoherences = [], {}, {}, 0
for uid, resid, q, job in c.execute("select id,resultId,quantities,jobId from RecipeData"):
    it = I.get(resid)
    if not it:
        continue
    ty = Ty.get(it[2])
    if not ty or ty[1] != 0:          # catégorie 0 = équipements
        continue
    tn = nm(ty[0]) or ''
    if 'Percepteur' in tn or tn in EXCLUS:
        continue
    n = nm(it[1])
    if not n or n.startswith('Cadeau'):
        continue
    q = json.loads(q)
    ids = ing.get(uid, [])
    if len(q) != len(ids):
        incoherences += 1
        continue
    types[it[2]] = tn
    for i in ids:
        res[i] = (nm(I[i][1]) if i in I else None) or str(i)
    items.append([resid, n, it[3], it[2], J.get(job, '') or '', [[i, x] for i, x in zip(ids, q)]])

items.sort(key=lambda x: x[1])
print(f"items={len(items)} ressources={len(res)} incoherences={incoherences}")
if len(items) < 2500 or incoherences > 50:
    print("Extraction anormale : data/recettes.json n'est pas modifié.")
    sys.exit(1)

d = {
    'src': 'Dofus 3 (dofus-sqlite, ' + datetime.date.today().strftime('%d/%m/%Y') + ')',
    'types': {str(k): v for k, v in types.items()},
    'res': {str(k): v for k, v in res.items()},
    'items': items,
}
with open(dst, 'w', encoding='utf-8') as f:
    f.write(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
