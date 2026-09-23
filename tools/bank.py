# -*- coding: utf-8 -*-
import json, sys, collections, re
sys.path.insert(0,'.')
from fmt import split_options, dejoin, repair, tighten, wrap_stem

A=json.load(open('out/answers.json',encoding='utf-8'))
Q=json.load(open('out/classified.json',encoding='utf-8'))
ORDER=["物理","化学","生物","衛生","薬理","薬剤","病態・薬物治療","法規・制度・倫理","実務"]
SLUG={"物理":"physics","化学":"chemistry","生物":"biology","衛生":"hygiene","薬理":"pharmacology",
      "薬剤":"pharmaceutics","病態・薬物治療":"pathology","法規・制度・倫理":"law","実務":"practice"}

for x in Q:
    x['answer']=A[str(x['kai'])][str(x['q'])]['answer']
    t=dejoin(repair(x['text']))
    stem,opts=split_options(t)
    x['_stem']=tighten(stem) if opts else tighten(t)
    x['_opts']=[tighten(o) for o in opts] if opts else None

import os
os.makedirs('out/bank',exist_ok=True)
index=[]
for s in ORDER:
    sub=[x for x in Q if x['subject']==s]
    cnt=collections.Counter(x['theme'] for x in sub)
    L=[f"# 必須問題 全問題集 ― {s}（{len(sub)}問）\n",
       f"第102回〜第111回の必須問題のうち **{s}** の全{len(sub)}問を、テーマ別・出題回順に並べたもの。",
       "**正答は厚生労働省公表の正答表から取り込んだ公式の値**（`docs/07` の照合結果を参照）。\n",
       "各問題の「正答を見る」を開くまでは答えが見えないので、そのまま演習に使える。\n",
       "| テーマ | 問題数 |","|---|---:|"]
    for t,n in cnt.most_common(): L.append(f"| {t} | {n} |")
    L.append("")
    for t,n in cnt.most_common():
        L.append(f"\n---\n\n## {t}（{n}問）\n")
        for x in sorted([y for y in sub if y['theme']==t], key=lambda y:(y['kai'],y['q'])):
            L.append(f"\n**`第{x['kai']}回 問{x['q']}`**\n")
            if x['_opts']:
                for ln in wrap_stem(x['_stem']): L.append(ln+"  ")
                L.append("")
                for j,o in enumerate(x['_opts'],1): L.append(f"&nbsp;&nbsp;{j}.　{o}  ")
            else:
                L.append("> ⚠ 構造式・図の読み取りが必要な問題です。原文PDFと併せて確認してください。\n")
                L.append(x['_stem']+"  ")
            L.append("")
            L.append("<details><summary>　正答を見る　</summary>\n")
            L.append(f"**正答：{x['answer']}**（厚生労働省 公表値）\n")
            L.append("</details>\n")
    open(f'out/bank/{SLUG[s]}.md','w',encoding='utf-8').write('\n'.join(L))
    index.append((s,len(sub),SLUG[s]))
    print(f'{s}: {len(sub)}問 -> bank/{SLUG[s]}.md')

json.dump(Q,open('out/classified.json','w',encoding='utf-8'),ensure_ascii=False,indent=1)
json.dump(index,open('out/bank_index.json','w',encoding='utf-8'),ensure_ascii=False)
