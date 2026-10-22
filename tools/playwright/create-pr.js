'use strict';
/**
 * Creates the pull request through the GitHub REST API using the credential that
 * the git credential manager already holds (the same one that made `git push`
 * work). No new credential is introduced.
 */
const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');

const OWNER = 'skerishKang';
const REPO = 'kbs261022';
const BASE = process.argv[2] || 'main';
const HEAD = process.argv[3] || 'research/playwright-browser-analysis';
const TITLE = process.argv[4] || 'feat(research): 삼아스토어 Playwright 브라우저 분석 (이슈 #5)';
const BODY_FILE = process.argv[5];

function getToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = out.match(/^password=(.*)$/m);
  if (!m) throw new Error('no github credential available');
  return m[1].trim();
}

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'cgi-playwright-pr',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const token = getToken();
  const body = BODY_FILE ? fs.readFileSync(BODY_FILE, 'utf8') : '';

  // check whether a PR for this branch already exists
  const existing = await api('GET', `/repos/${OWNER}/${REPO}/pulls?head=${OWNER}:${HEAD}&state=all`, null, token);
  if (existing.json && existing.json.length) {
    console.log(`PR already exists: ${existing.json[0].html_url} (${existing.json[0].state})`);
    process.exit(0);
  }

  const res = await api('POST', `/repos/${OWNER}/${REPO}/pulls`, {
    title: TITLE,
    head: HEAD,
    base: BASE,
    body,
    maintainer_can_modify: true,
  }, token);

  if (res.status !== 201) {
    console.error(`FAILED ${res.status}`);
    console.error(res.text.slice(0, 2000));
    process.exit(1);
  }
  console.log(`PR created: ${res.json.html_url}`);
  console.log(`  number: ${res.json.number}`);
  console.log(`  title : ${res.json.title}`);
  console.log(`  base  : ${res.json.base.ref}  head: ${res.json.head.ref}`);
  console.log(`  state : ${res.json.state}  draft: ${res.json.draft}`);
})().catch((e) => { console.error(e); process.exit(1); });
