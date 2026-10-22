'use strict';
/**
 * Updates an existing pull request body / title through the GitHub REST API
 * using the credential that the git credential manager already holds.
 *
 * Usage: node update-pr.js <pr-number> <body-file> [title]
 */
const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');

const PR = process.argv[2];
const BODY_FILE = process.argv[3];
const TITLE = process.argv[4];

function getToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  return out.match(/^password=(.*)$/m)[1].trim();
}

function api(method, path, body, token, attempt = 1) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path, method,
      agent: new https.Agent({ keepAlive: false }),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'cgi-playwright-pr',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Connection: 'close',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
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
      if (attempt < 3) { setTimeout(() => resolve(api(method, path, body, token, attempt + 1)), 800 * attempt); return; }
      reject(e);
    });
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const token = getToken();
  const body = fs.readFileSync(BODY_FILE, 'utf8');
  const payload = { body };
  if (TITLE) payload.title = TITLE;
  const res = await api('PATCH', `/repos/skerishKang/kbs261022/pulls/${PR}`, payload, token);
  if (res.status !== 200) {
    console.error(`FAILED ${res.status}`);
    console.error(res.text.slice(0, 1500));
    process.exit(1);
  }
  console.log(`updated PR #${res.json.number}: ${res.json.html_url}`);
  console.log(`  mergeable=${res.json.mergeable} state=${res.json.mergeable_state}`);
})().catch((e) => { console.error(e); process.exit(1); });
