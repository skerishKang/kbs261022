'use strict';
/**
 * Conflict check: merges this branch into every other open branch in the
 * repository and reports whether any of them produces a merge conflict.
 *
 * Usage: node check-branch-conflicts.js [branch ...]
 *        (no argument -> all remote branches except main and this one)
 */
const { execFileSync } = require('child_process');

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

const SELF = 'research/playwright-browser-analysis';

(async () => {
  const remotes = sh('git', ['branch', '-r', '--format=%(refname:short)'])
    .split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((b) => b !== 'origin/main' && b !== `origin/${SELF}` && b !== 'origin/HEAD' && b !== 'origin');

  const targets = process.argv.slice(2).length
    ? process.argv.slice(2).map((b) => (b.startsWith('origin/') ? b : `origin/${b}`))
    : remotes;

  const results = [];
  for (const t of targets) {
    const work = `tmp/conflict-check-${t.replace(/[^a-z0-9]+/gi, '-')}`;
    let conflict = false;
    let files = [];
    try {
      sh('git', ['checkout', '-q', '-B', work, t]);
      try {
        sh('git', ['merge', '--no-commit', '--no-ff', SELF], { stdio: 'pipe' });
      } catch {
        // a non-zero exit can also mean "merge succeeded but --no-commit stopped"
      }
      files = sh('git', ['diff', '--name-only', '--diff-filter=U']).split('\n').map((s) => s.trim()).filter(Boolean);
      conflict = files.length > 0;
    } catch (e) {
      conflict = true;
      files = [`<merge failed: ${String(e.message).split('\n')[0]}>`];
    } finally {
      try { sh('git', ['merge', '--abort']); } catch { /* nothing to abort */ }
      try { sh('git', ['checkout', '-q', SELF]); } catch { /* ignore */ }
      try { sh('git', ['branch', '-D', work]); } catch { /* ignore */ }
    }
    results.push({ branch: t, conflict, files });
  }

  let bad = 0;
  results.forEach((r) => {
    if (r.conflict) { bad += 1; console.log(`CONFLICT  ${r.branch}: ${r.files.join(', ')}`); }
    else console.log(`clean     ${r.branch}`);
  });
  console.log(`\n${results.length - bad}/${results.length} branches merge cleanly`);
  process.exit(bad === 0 ? 0 : 1);
})();
