# Checker comparisons

Run `pnpm check --base <commit/ref>` for a PR. The default selected ref is
`origin/main`; `LOCALDEV_CHECK_BASE` can set it for a different base branch.
The comparison uses the selected commit's merge-base with `HEAD`, and prints
both exact SHAs and the selected ref. Fetch that ref before checking. A missing
ref, unreadable Git tree or missing merge-base fails the check with an action;
there is no empty-base fallback. The current input includes tracked files and
unignored untracked files, so checking before a commit still covers new work.

The existing strict source rules and baseline ratchets retain their meanings.
The additional rules compare individual findings with that merge-base:

- `test/public-api`: assertion inputs derived from direct reads of private
  `sessions` paths or `receipt.json`, including parsed fields, and probes of
  reconstructed session directories. Use the owner's exports or built CLI
  output for behavior, and paths supplied by public results or reservation
  callbacks for cleanup.
  Callbacks executed by Node's `throws`, `doesNotThrow`, `rejects` and
  `doesNotReject` are assertion inputs too; unrelated synchronization callbacks
  stay separate.
- `imports/direction`: local imports between the owner layers listed in
  **Where code belongs** in `CODING_STANDARDS.md` cannot point upward. Owners
  outside that list remain subject to the boundaries lens's judgment.
- `imports/process-entry`: nothing imports `supervisor`, `guard`,
  `proxy-process` or `outbound-preload`. Tests importing their built `dist`
  files are checked against the corresponding source owners too.
- `imports/cycle`: each local edge participating in a cycle is a finding.
  Static imports, re-exports, TypeScript import types/equals, literal `import()` and literal `require()` are
  resolved across local TypeScript/JavaScript extensions and directory indexes.
- `size/folder-files`: a folder above ten direct handwritten files cannot be
  new or grow beyond its base count. This counts regular repository files,
  including docs and configuration; symlinks, generated `dist`, dependencies,
  scratch work and generated package lockfiles are excluded.

A finding is identified by rule, file, syntax and (for assertions) enclosing
test/function names. Copies have separate occurrences. Unchanged existing
debt passes; edited assertions, new copies and findings moved to another file
or test fail. Removing an old finding cannot offset a different one. Line
numbers are reported but are not identities, so inserting unrelated lines
above existing debt does not create a finding. Folder comparisons are per
folder, never one total count.

Malformed-input writes and storage reads used solely for synchronization are
allowed because they are not assertion inputs. Their storage values becoming
assertion evidence still fails. There are no filename exceptions or suppression
comments. The isolated fixtures in `test/checks` cover both sides of this rule.

This is bounded static analysis, not a replacement for review. It follows
local bindings, helper returns and assignments within a test file, but does
not model arbitrary code execution, computed import names, external helper
implementations or custom assertion libraries. Reviewers still judge ownership,
the purpose of setup/barriers, and behavior asserted by other means. Checker
fixtures are source strings; they never create real session receipts or modify
production source. The normal check still builds and runs runtime tests serially.
