#!/usr/bin/env python3
"""Archive incident logs deterministically, redacting recognizable credentials."""
import gzip, hashlib, json, pathlib, re
ROOT=pathlib.Path(__file__).resolve().parents[1]
data=ROOT/'docs/case-studies/issue-195/data'
patterns=[('github',re.compile(r'(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})')),('api',re.compile(r'sk-(?:ant-)?[A-Za-z0-9_-]{20,}')),('telegram',re.compile(r'\b\d{8,12}:[A-Za-z0-9_-]{30,}')),('authorization',re.compile(r'(?i)(Bearer\s+)[A-Za-z0-9_.-]{20,}'))]
def redact(s,counts):
 for name,rx in patterns:
  s,n=rx.subn('[REDACTED-'+name.upper()+']',s);counts[name]=counts.get(name,0)+n
 return s
manifest=[]
for source in sorted(data.glob('gist-*.log')):
 original=hashlib.sha256();redacted=hashlib.sha256();counts={};lines=0
 target=source.with_suffix('.log.gz');excerpt=[]
 with open(source,'rb') as infile,open(target,'wb') as outfile,gzip.GzipFile(filename='',fileobj=outfile,mode='wb',mtime=0) as archive:
  for raw in infile:
   lines+=1;original.update(raw);clean=redact(raw.decode('utf8',errors='replace'),counts);encoded=clean.encode();redacted.update(encoded);archive.write(encoded)
   if re.search(r'no space left on device|Failed to acquire lock|Main process exited|using the force|Killed process.*dockerd|empty lock',clean,re.I):
    if len(excerpt)<200:excerpt.append(f'{lines}: {clean.rstrip()[:650]}\n')
 gid=source.stem[5:]
 manifest.append({'source':'https://gist.github.com/'+gid,'archive':target.name,'lineCount':lines,'originalSHA256':original.hexdigest(),'redactedSHA256':redacted.hexdigest(),'archiveSHA256':hashlib.sha256(target.read_bytes()).hexdigest(),'redactions':counts})
 (data/(source.stem+'-excerpts.txt')).write_text(''.join(excerpt))
(data/'evidence-manifest.json').write_text(json.dumps({'retrievedAt':'2026-10-09','method':'gh gist view (authenticated), complete text; deterministic gzip; credentials redacted only','logs':manifest},indent=2)+'\n')
for case,n in [('issue-193',2889),('issue-194',2892)]:
 folder=ROOT/'docs/case-studies'/case/'data'
 for suffix in ['', '-comments']:
  (folder/f'hive-mind-{n}{suffix}.json').write_bytes((data/f'hive-mind-{n}{suffix}.json').read_bytes())
 (folder/'evidence-manifest.json').write_text(json.dumps({'sharedArchiveRoot':'../../issue-195/data','manifest':'../../issue-195/data/evidence-manifest.json','reason':'Both incidents use the same three full logs; preserve one checksummed canonical archive to avoid duplication.'},indent=2)+'\n')
print(json.dumps([{'archive':m['archive'],'lines':m['lineCount'],'redactions':m['redactions']} for m in manifest],indent=2))
