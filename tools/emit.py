# -*- coding: utf-8 -*-
import json, csv, os, collections, sys, re
sys.path.insert(0,'.')
from fmt import wrap_stem
Q=json.load(open('out/final.json',encoding='utf-8'))
ORDER=["物理","化学","生物","衛生","薬理","薬剤","病態・薬物治療","法規・制度・倫理","実務"]
SLUG={"物理":"physics","化学":"chemistry","生物":"biology","衛生":"hygiene","薬理":"pharmacology",
      "薬剤":"pharmaceutics","病態・薬物治療":"pathology","法規・制度・倫理":"law","実務":"practice"}
os.makedirs('out/bank',exist_ok=True)

def tags(x):
    t=[]
    if x['qtype']=='否定形': t.append('⚠️否定形')
    if x['is_calc']: t.append('🔢計算')
    if x['needs_figure']: t.append('📐図・構造式')
    if x['n_options']==6: t.append('選択肢6')
    return t

# ---------- Markdown 問題集 ----------
for s in ORDER:
    sub=[x for x in Q if x['subject']==s]
    cnt=collections.Counter(x['theme'] for x in sub)
    L=[f"# 必須問題 全問集 ― {s}（{len(sub)}問）\n",
       f"第102〜111回の必須問題のうち **{s}** の**全{len(sub)}問**。抜粋ではなく全件です。",
       "正答は厚生労働省公表の正答表から取り込んだ公式値です。\n",
       "## 各問に付いている指標\n",
       "| 表示 | 意味 |","|---|---|",
       "| `テーマ（10年N問・M/10回）` | そのテーマが10年間に何問出たか／何回の試験に登場したか |",
       "| `⚠️否定形` | 「誤っているのはどれか」「〜でないのはどれか」型。読み違えやすい |",
       "| `🔢計算` | 数値計算を要する問題 |",
       "| `📐図・構造式` | 図や構造式の読み取りが必要（本文だけでは解けない。原文PDF参照） |",
       "| `選択肢6` | 選択肢が6つある問題 |",
       "| `正答率` | **未取得**。厚労省は問題別正答率を公表していないため空欄 |",
       "",
       "## テーマ別の内訳\n",
       "| テーマ | 問題数 | 出題回数 |","|---|---:|---:|"]
    for t,n in cnt.most_common():
        yr=len(set(x['kai'] for x in sub if x['theme']==t))
        L.append(f"| {t} | {n} | {yr}/10回 |")
    L.append("")
    for t,n in cnt.most_common():
        yr=len(set(x['kai'] for x in sub if x['theme']==t))
        L.append(f"\n---\n\n## {t}\n")
        L.append(f"**10年で{n}問・{yr}/10回の試験に出題**\n")
        for x in sorted([y for y in sub if y['theme']==t], key=lambda y:(y['kai'],y['q'])):
            tg=tags(x)
            meta=f"`第{x['kai']}回 問{x['q']}`　{t}（10年{n}問・{yr}/10回）　正答率: —"
            if tg: meta+="　"+" ".join(tg)
            L.append(f"\n**{meta}**\n")
            if x['options']:
                for ln in wrap_stem(x['stem']): L.append(ln+"  ")
                L.append("")
                for j,o in enumerate(x['options'],1): L.append(f"&nbsp;&nbsp;{j}.　{o}  ")
            else:
                L.append("> 図・構造式が本文に含まれるため、選択肢を文章として取り出せません。原文PDFと併せて確認してください。\n")
                L.append(x['stem']+"  ")
            L.append("")
            L.append("<details><summary>　正答を見る　</summary>\n")
            ansidx=x['answer']
            body=f"**正答：{ansidx}**"
            if x['options'] and ansidx.isdigit() and 1<=int(ansidx)<=len(x['options']):
                body+=f"　— {x['options'][int(ansidx)-1]}"
            L.append(body+"\n")
            L.append("</details>\n")
    open(f'out/bank/{SLUG[s]}.md','w',encoding='utf-8').write('\n'.join(L))
print('Markdown:', {s:sum(1 for x in Q if x['subject']==s) for s in ORDER})

# ---------- CSV / TSV マスタ ----------
HEAD=['回','問番号','科目','テーマ','テーマ出題数_10年','テーマ出題回数_10年','設問形式','計算問題','図構造式',
      '選択肢数','問題文字数','問題文','選択肢1','選択肢2','選択肢3','選択肢4','選択肢5','正答','正答率','類題']
def row(x):
    o=x['options'] or ['','','','','']
    o=(o+['']*5)[:5]
    return [x['kai'],x['q'],x['subject'],x['theme'],x['theme_count_10y'],x['theme_years_10y'],
            x['qtype'],'○' if x['is_calc'] else '','○' if x['needs_figure'] else '',
            x['n_options'] or '', x['char_len'], x['stem'], *o, x['answer'], '', ' '.join(x['similar_qs'])]
rows=[row(x) for x in sorted(Q,key=lambda y:(y['kai'],y['q']))]
with open('out/hissu_master.csv','w',encoding='utf-8-sig',newline='') as f:
    w=csv.writer(f); w.writerow(HEAD); w.writerows(rows)
with open('out/hissu_master.tsv','w',encoding='utf-8',newline='') as f:
    w=csv.writer(f,delimiter='\t',quoting=csv.QUOTE_MINIMAL); w.writerow(HEAD); w.writerows(rows)
print('CSV/TSV:',len(rows),'行')

# ---------- Anki ----------
def esc(s): return re.sub(r'[\t\r\n]',' ',str(s))
with open('out/anki_hissu.tsv','w',encoding='utf-8') as f:
    f.write('#separator:tab\n#html:true\n#columns:Front\tBack\tTags\n')
    for x in sorted(Q,key=lambda y:(y['kai'],y['q'])):
        head=f"【第{x['kai']}回 問{x['q']}】{x['subject']}・{x['theme']}"
        tg=tags(x)
        if tg: head+="　"+" ".join(tg)
        front=head+"<br><br>"+esc(x['stem'])
        if x['options']:
            front+="<br><br>"+"<br>".join(f"{i}. {esc(o)}" for i,o in enumerate(x['options'],1))
        else:
            front+="<br><br>※図・構造式が必要な問題です"
        back=f"<b>正答：{x['answer']}</b>"
        if x['options'] and x['answer'].isdigit() and 1<=int(x['answer'])<=len(x['options']):
            back+=f"<br>{esc(x['options'][int(x['answer'])-1])}"
        back+=f"<br><br>テーマ：{x['theme']}（10年{x['theme_count_10y']}問・{x['theme_years_10y']}/10回）"
        tagstr=' '.join(['薬剤師国家試験','必須問題',
                         '科目::'+x['subject'].replace('・','_'),
                         'テーマ::'+x['theme'].replace('・','_').replace(' ',''),
                         f"第{x['kai']}回"]+([ 'flag::否定形'] if x['qtype']=='否定形' else [])
                        +(['flag::計算'] if x['is_calc'] else [])+(['flag::図'] if x['needs_figure'] else []))
        f.write(f"{front}\t{back}\t{tagstr}\n")
print('Anki: 900行')
