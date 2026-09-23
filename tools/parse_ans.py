import re, json, glob, os
from pdfminer.high_level import extract_text
SUBJ=r'(物理|化学|生物|衛生|薬理|薬剤|病態|法規|実務|実践)'
ROW=re.compile(r'^\s*(\d{1,3})\s+'+SUBJ+r'\s+([1-5](?:\s*[,，、]\s*[1-5])*)\s*$')
res={}
for p in sorted(glob.glob('ans/*.pdf')):
    kai=int(os.path.basename(p)[:3])
    txt=extract_text(p)
    open(f'anstxt/{kai}.txt','w',encoding='utf-8').write(txt)
    d={}
    for ln in txt.split('\n'):
        m=ROW.match(ln)
        if m:
            n=int(m.group(1))
            d[n]={'subject_official':m.group(2),'answer':re.sub(r'\s','',m.group(3))}
    hissu={k:v for k,v in d.items() if k<=90}
    miss=[i for i in range(1,91) if i not in hissu]
    res[kai]=d
    print(f'{kai}: 全{len(d)}問 / 必須{len(hissu)}/90  欠損={miss[:8]}')
json.dump(res,open('out/answers.json','w',encoding='utf-8'),ensure_ascii=False,indent=1)
