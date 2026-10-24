## Summary

In 0.12.1 the token of an `Authorization: <scheme> <token>` header ends at the first `]` or `}`, and it does not end at a NUL byte. As a result:

- Sanitizing an already sanitized log is not idempotent: `Bearer [REDACTED]` becomes `[REDACTED]]`.
- Template placeholders leave their closing brackets behind: `Bearer {{token}}` becomes `[REDACTED]}}`.
- With `--allow-binary`, a NUL right after the token is masked along with it, so the output no longer keeps every non-secret byte.

Found while moving start-command to 0.12.1, which dropped its own Authorization pre-pass now that #45 is fixed (link-foundation/start#253). start sanitizes terminal transcripts, and those often hold logs that were already sanitized.

## Reproduction

`@link-foundation/sensitive-data-sanitizer` 0.12.1, Node.js 22, run with `redact - --credentials-only --allow-binary`:

| Input                                      | Output                                | Expected                                                                |
| ------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------- |
| `Authorization: Bearer [REDACTED] already` | `Authorization: [REDACTED]] already`  | `Authorization: Bearer [REDACTED] already` (or `[REDACTED] already`)    |
| `Authorization: Bearer {{token}} x`        | `Authorization: [REDACTED]}} x`       | `Authorization: [REDACTED] x` (or the placeholder kept, like `<token>`) |
| `Authorization: Bearer <token> x`          | `Authorization: [REDACTED] <token> x` | (consistent, for comparison)                                            |
| `Authorization: Bearer abc\0 tail`         | `Authorization: [REDACTED] tail`      | `Authorization: [REDACTED]\0 tail`                                      |

```sh
printf 'Authorization: Bearer [REDACTED] already\n' | sensitive-data-sanitizer redact - --credentials-only
printf 'Authorization: Bearer abc\0 tail\n' | sensitive-data-sanitizer redact - --credentials-only --allow-binary | od -c
```

A NUL after a non-Authorization credential is kept (`ghp_…\0` becomes `[REDACTED]\0`), so only the Authorization path is affected.

Script: [experiments/issue-253/sanitizer-findings.sh](https://github.com/link-foundation/start/blob/issue-253-480126f69838/experiments/issue-253/sanitizer-findings.sh)

## Cause

`authorizationRange` in `src/context.js`:

```js
if (text.startsWith(REDACTED, start)) {
  return undefined;
}
const match = /^(?:[a-z][a-z0-9_-]*[ \t]+)?[^\s"'\\,<>}\]]+/i.exec(
  text.slice(start)
);
```

- The `REDACTED` guard runs only before the scheme, so `Bearer [REDACTED]` slips past it. The token class then stops at `]` and masks `[REDACTED`.
- `}` and `]` end the token even when the token itself opened the bracket (`{{token}}`, `[REDACTED]`).
- `\0` and other C0 control bytes are not in the excluded class, so they become part of the token.

## Suggested fix

- Also skip, or keep unchanged, a token that starts with `[REDACTED]` after the scheme.
- When a token starts with `{`, `[` or `<`, end it at the matching closing bracket, or treat it as a placeholder the way `<token>` already is. Do not cut it at the first closing bracket.
- Add `\0` (`\x00-\x1f`) to the excluded class.
- Add the four rows above to the test suite.
