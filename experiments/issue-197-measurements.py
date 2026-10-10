"""Reproducible bounded GitHub baseline; raw snapshots remain in data/."""
import collections
import json
from pathlib import Path

folder = Path('docs/case-studies/issue-197/data')
runs = json.loads((folder / 'runs-before.json').read_text())
events = [event for page in json.loads((folder / 'repository-events-before.json').read_text()) for event in page]
branches = ['issue-195-cd307f03a9cf', 'issue-183-4cba24615d2f', 'issue-203-b56519b4c758']
report = {'runWindow': {'total': len(runs), 'oldest': min(run['createdAt'] for run in runs), 'newest': max(run['createdAt'] for run in runs)}, 'eventWindow': {'total': len(events), 'oldest': min(event['created_at'] for event in events), 'newest': max(event['created_at'] for event in events)}, 'nonMainConclusions': dict(collections.Counter(run['conclusion'] or 'pending' for run in runs if run['headBranch'] != 'main')), 'branches': []}
for branch in branches:
    related = [run for run in runs if run['headBranch'] == branch]
    pushes = [event for event in events if event['type'] == 'PushEvent' and event['payload']['ref'] == 'refs/heads/' + branch]
    report['branches'].append({'branch': branch, 'pushesInEventWindow': len(pushes), 'pushEvents': [{'id': event['id'], 'createdAt': event['created_at'], 'head': event['payload']['head'], 'before': event['payload']['before']} for event in pushes], 'distinctCiHeadShas': len({run['headSha'] for run in related}), 'conclusions': dict(collections.Counter(run['conclusion'] or 'pending' for run in related))})
(folder / 'measurements-before.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
