# -*- coding: utf-8 -*-
import json, re, collections, sys
sys.path.insert(0,'.')
from fmt import split_options, dejoin, repair, tighten
Q=json.load(open('out/classified.json',encoding='utf-8'))

NEG=['誤っている','適切でない','正しくない','該当しない','含まれない','でないのはどれか','ないのはどれか',
     '適切でないのは','関与しないのは','用いられないのは','必要としないのは','行わないのは','不適切']
NUM=re.compile(r'^[0-9０-９][0-9０-９．\.,、〜~\-+×/ ]*[0-9０-９]?\s*[a-zA-Zμµ%％/·\.\s]*$')
CALCW=['求め','いくらか','いくつ','最も近い値','最も近いのは','計算','何 mL','何mL','濃度は','速度は']

for x in Q:
    t=dejoin(repair(x['text']))
    stem,opts=split_options(t)
    x['stem']=tighten(stem) if opts else tighten(t)
    x['options']=[tighten(o) for o in opts] if opts else None
    # 選択肢6以上の有無
    n=5
    if opts:
        m=re.search(r'(?<=\s)6(?=\s)', t[t.index(opts[-1]) if opts[-1] in t else 0:])
        if m and re.search(r'\s6\s+\S', t): n=6
    x['n_options']=n if opts else None
    x['qtype']='否定形' if any(k in x['stem'] for k in NEG) else '肯定形'
    numeric = bool(opts) and all(NUM.match(o.strip()) for o in opts)
    x['is_calc'] = numeric or any(k in x['stem'] for k in CALCW)
    x['needs_figure']=bool(x.get('fig'))
    x['char_len']=len(x['stem'])

# テーマ統計
key=lambda x:(x['subject'],x['theme'])
cnt=collections.Counter(key(x) for x in Q)
yrs=collections.defaultdict(set)
for x in Q: yrs[key(x)].add(x['kai'])
for x in Q:
    k=key(x)
    x['theme_count_10y']=cnt[k]
    x['theme_years_10y']=len(yrs[k])
    x['similar_qs']=[f"{y['kai']}-{y['q']}" for y in Q if key(y)==k and (y['kai'],y['q'])!=(x['kai'],x['q'])]

json.dump(Q,open('out/final.json','w',encoding='utf-8'),ensure_ascii=False,indent=1)
print('否定形:',sum(1 for x in Q if x['qtype']=='否定形'),'/900')
print('計算問題:',sum(1 for x in Q if x['is_calc']),'/900')
print('図・構造式が必要:',sum(1 for x in Q if x['needs_figure']),'/900')
print('選択肢6:',sum(1 for x in Q if x['n_options']==6))
print('選択肢に分解できない:',sum(1 for x in Q if not x['options']))
print('\n科目別 否定形の割合:')
for s in ["物理","化学","生物","衛生","薬理","薬剤","病態・薬物治療","法規・制度・倫理","実務"]:
    sub=[x for x in Q if x['subject']==s]
    neg=sum(1 for x in sub if x['qtype']=='否定形')
    calc=sum(1 for x in sub if x['is_calc'])
    print(f"  {s}: 否定形{neg}/{len(sub)} ({neg/len(sub)*100:.0f}%)  計算{calc}")
