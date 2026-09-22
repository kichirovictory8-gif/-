import re, json, glob, os

SUBJECT_RANGES=[(1,15,"物理・化学・生物"),(16,25,"衛生"),(26,40,"薬理"),(41,55,"薬剤"),
                (56,70,"病態・薬物治療"),(71,80,"法規・制度・倫理"),(81,90,"実務")]
def subject(n):
    for a,b,s in SUBJECT_RANGES:
        if a<=n<=b: return s
    return "?"

NOISE=[re.compile(r'^\(cid:\d+\)$'),re.compile(r'^DKJY'),re.compile(r'^\d{4}/\d{1,2}/\d{1,2}'),
       re.compile(r'^[―—\-\s　]+$'),re.compile(r'^\s*\d{1,3}\s*$'),re.compile(r'\.indd'),
       re.compile(r'^第\s*\d+\s*回')]
def clean(txt):
    out=[]
    for ln in txt.split('\n'):
        s=ln.strip()
        if not s: continue
        if any(p.search(s) for p in NOISE): continue
        s=re.sub(r'^[―—\-\s　]+(?=問\s*\d)','',s)          # page footer glued to 問N
        s=re.sub(r'^DKJY-\d.indd\s+\d+\s*','',s)
        out.append(s)
    return '\n'.join(out)

MARK=re.compile(r'問\s*(\d{1,3})[　\s]')
BAD_PREV=set('質設訪疑学難')

def parse(path):
    txt=clean(open(path,encoding='utf-8').read())
    hits=[]
    expected=1
    for m in MARK.finditer(txt):
        if int(m.group(1))!=expected: continue
        if m.start()>0 and txt[m.start()-1] in BAD_PREV: continue
        if txt[m.end():m.end()+12].lstrip().startswith('から問'): continue  # cover-page notice
        hits.append((expected,m.start(),m.end()))
        expected+=1
        if expected>90: break
    qs={}
    for i,(n,s,e) in enumerate(hits):
        end=hits[i+1][1] if i+1<len(hits) else len(txt)
        body=re.sub(r'\s+',' ',txt[e:end]).strip()
        qs[n]=body
    return qs

os.makedirs('out',exist_ok=True)
allq=[]
for p in sorted(glob.glob('txt/*.txt')):
    kai=int(os.path.basename(p)[:3])
    qs=parse(p)
    missing=[i for i in range(1,91) if i not in qs]
    print(f'{kai}: {len(qs)}/90 missing={missing[:8]}')
    for n in sorted(qs):
        allq.append({'kai':kai,'q':n,'subject':subject(n),'text':qs[n]})
json.dump(allq,open('out/questions.json','w',encoding='utf-8'),ensure_ascii=False,indent=1)
print('total',len(allq))
