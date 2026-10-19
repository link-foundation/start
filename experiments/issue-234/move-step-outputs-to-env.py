"""Move `${{ steps.*.outputs.* }}` out of `run:` blocks into step `env:` (issue #234).

zizmor reports each as template-injection; a value expanded into the script
text is parsed by the shell, while an environment variable is not.
Usage: python3 -I move-step-outputs-to-env.py <workflow.yml>...
"""
import re
import sys

NAMES = {
    'steps.publish.outputs.published_version': 'RELEASE_VERSION',
    'steps.current_version.outputs.version': 'RELEASE_VERSION',
    'steps.version.outputs.new_version': 'RELEASE_VERSION',
    'steps.bump_type.outputs.bump_type': 'BUMP_TYPE',
}
EXPR = re.compile(r'\$\{\{ (steps\.[\w-]+\.outputs\.[\w-]+) \}\}')


def rewrite(lines):
    starts = [i for i, l in enumerate(lines) if re.match(r'^      - ', l)] + [len(lines)]
    out = list(lines)
    for start, end in reversed(list(zip(starts, starts[1:]))):
        step = out[start:end]
        run = next((i for i, l in enumerate(step) if re.match(r'^        run:', l)), None)
        if run is None:
            continue
        used = {}
        for i in range(run, len(step)):
            if i > run and re.match(r'^ {0,8}\S', step[i]):
                break
            for expr in EXPR.findall(step[i]):
                if expr not in NAMES:
                    raise SystemExit(f'no name for {expr}')
                used[NAMES[expr]] = expr
            step[i] = EXPR.sub(lambda m: '${' + NAMES[m[1]] + '}', step[i])
        if not used:
            continue
        entries = [f'          {name}: ${{{{ {expr} }}}}' for name, expr in used.items()]
        env = next((i for i, l in enumerate(step) if l == '        env:'), None)
        if env is None:
            step[run:run] = ['        env:'] + entries
        else:
            step[env + 1:env + 1] = entries
        out[start:end] = step
    return out


for path in sys.argv[1:]:
    text = open(path).read()
    open(path, 'w').write('\n'.join(rewrite(text.split('\n'))))
