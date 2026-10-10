"""Collect one finite same-SHA CI snapshot and preserve every failed run log."""

import argparse
import datetime
import json
import re
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--sha', required=True)
parser.add_argument('--label', required=True)
parser.add_argument('--push-ledger', type=Path, required=True)
args = parser.parse_args()
if not re.fullmatch(r'[a-f0-9]{40}', args.sha):
    parser.error('--sha must be a full commit SHA')
if not re.fullmatch(r'[a-zA-Z0-9-]+', args.label):
    parser.error('--label must contain only letters, digits and hyphens')

repository = 'link-foundation/start'
branch = 'issue-203-b56519b4c758'
data = Path('docs/case-studies/issue-197/data')
logs = Path('ci-logs')
logs.mkdir(exist_ok=True)


def github_json(arguments):
    return json.loads(subprocess.check_output(['gh', *arguments], text=True))


runs = github_json([
    'run', 'list', '--repo', repository, '--branch', branch, '--limit', '100',
    '--json', 'databaseId,conclusion,createdAt,updatedAt,headSha,status,name,url',
])
latest = [run for run in runs if run['headSha'] == args.sha]
jobs = {}
for run in latest:
    pages = github_json([
        'api', f'repos/{repository}/actions/runs/{run["databaseId"]}/jobs',
        '--paginate', '--slurp',
    ])
    jobs[str(run['databaseId'])] = [job for page in pages for job in page['jobs']]
    if run['status'] == 'completed' and run['conclusion'] != 'success':
        name = re.sub(r'[^a-z0-9]+', '-', run['name'].lower()).strip('-')
        path = logs / f'{name}-{run["databaseId"]}.log'
        with path.open('w') as output:
            subprocess.run([
                'gh', 'run', 'view', str(run['databaseId']), '--repo', repository,
                '--log',
            ], stdout=output, check=True)
        path.with_suffix('.txt').write_bytes(path.read_bytes())

ledger = json.loads(args.push_ledger.read_text())
snapshot = {
    'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'repository': repository,
    'branch': branch,
    'headSha': args.sha,
    'pushLedger': ledger,
    'allBranchRuns': runs,
    'latestRuns': latest,
    'latestJobs': jobs,
    'counts': {
        'solverPushes': sum(entry['exitCode'] == 0 for entry in ledger),
        'failedRuns': sum(run['conclusion'] in ['failure', 'timed_out', 'startup_failure'] for run in runs),
        'cancelledRuns': sum(run['conclusion'] == 'cancelled' for run in runs),
        'latestPendingRuns': sum(run['status'] != 'completed' for run in latest),
    },
}
(data / f'ci-{args.label}.json').write_text(json.dumps(snapshot, indent=2) + '\n')
print(json.dumps({'headSha': args.sha, 'latestRuns': latest, 'counts': snapshot['counts']}, indent=2))
