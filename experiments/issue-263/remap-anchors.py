"""Remap parity translationBlocker line anchors after JS edits shift lines.

Each anchor's old line (on main) is mapped to its new line with difflib so
the anchor keeps pointing at the same construct. Run: python3 -I <this> main
"""
import difflib, json, subprocess, sys

base = sys.argv[1] if len(sys.argv) > 1 else 'main'
path = 'parity/features.json'
data = json.load(open(path))
cache = {}

def mapping(source):
    if source not in cache:
        old = subprocess.run(['git', 'show', f'{base}:{source}'], capture_output=True, text=True).stdout.split('\n')
        new = open(source).read().split('\n')
        table = {}
        for a, b, n in difflib.SequenceMatcher(None, old, new, autojunk=False).get_matching_blocks():
            for i in range(n):
                table[a + i + 1] = b + i + 1
        cache[source] = table
    return cache[source]

changed = set(subprocess.run(['git', 'diff', '--name-only', base, '--', 'js/src'], capture_output=True, text=True).stdout.split())
for feature in data['features']:
    for blocker in feature.get('translationBlockers', []):
        if blocker['source'] in changed:
            new_line = mapping(blocker['source']).get(blocker['line'])
            if new_line and new_line != blocker['line']:
                print(feature['id'], blocker['source'], blocker['line'], '->', new_line)
                blocker['line'] = new_line
            elif not new_line:
                print('UNMAPPED', feature['id'], blocker['source'], blocker['line'])
open(path, 'w').write(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
