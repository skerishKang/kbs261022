'use strict';
/**
 * Verifies the created PR: metadata, files changed, and mergeability
 * (i.e. no conflict with the existing branches).
 */
const { execFileSync } = require('child_process');
const https = require('https');

const OWNER = 'skerishKang';
const REPO = 'kbs261022';
const PR = process.argv[2] || '23';

function getToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  return out.match(/^password=(.*)$/m)[1].trim();
}

function api(path, token, attempt = 1) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path, method: 'GET',
      agent: new https.Agent({ keepAlive: false }),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'cgi-playwright-pr',
        Authorization: `Bearer ${token}`,
        Connection: 'close',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', (e) => {
      if (attempt < 3) {
        setTimeout(() => resolve(api(path, token, attempt + 1)), 800 * attempt);
        return;
      }
      reject(e);
    });
    req.end();
  });
}

(async () => {
  const token = getToken();
  const pr = await api(`/repos/${OWNER}/${REPO}/pulls/${PR}`, token);
  const p = pr.json;
  console.log(`PR #${p.number}  ${p.html_url}`);
  console.log(`  title      : ${p.title}`);
  console.log(`  state      : ${p.state}  draft=${p.draft}  merged=${p.merged}`);
  console.log(`  base/head  : ${p.base.ref} <- ${p.head.ref}`);
  console.log(`  mergeable  : ${p.mergeable}  state=${p.mergeable_state}  rebaseable=${p.rebaseable}`);
  console.log(`  commits    : ${p.commits}   changed_files=${p.changed_files}  +${p.additions}/-${p.deletions}`);
  console.log(`  body len   : ${(p.body || '').length}`);

  const files = await api(`/repos/${OWNER}/${REPO}/pulls/${PR}/files?per_page=100`, token);
  const list = files.json || [];
  const byTop = {};
  list.forEach((f) => {
    const top = f.filename.split('/').slice(0, 2).join('/');
    byTop[top] = (byTop[top] || 0) + 1;
  });
  console.log('  files by area:');
  Object.entries(byTop).sort().forEach(([k, v]) => console.log(`    ${k}: ${v}`));

  // list the repo branches so we can confirm no conflict with existing work
  const branches = await api(`/repos/${OWNER}/${REPO}/branches?per_page=100`, token);
  console.log('  repo branches:');
  (branches.json || []).forEach((b) => console.log(`    ${b.name}`));
})().catch((e) => { console.error(e); process.exit(1); });
