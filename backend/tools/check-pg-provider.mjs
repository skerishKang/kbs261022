#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sitePath = resolve(repoRoot, 'site/config.js');
const workerConfigs = [
  resolve(repoRoot, 'backend/wrangler.toml'),
  resolve(repoRoot, 'backend/wrangler.sandbox.toml'),
];

function requiredMatch(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) throw new Error(`missing ${label}`);
  return match[1].trim().toLowerCase();
}

function readVarsString(source, name) {
  let section = '';
  for (const line of source.split(/\r?\n/)) {
    const header = line.trim().match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1];
      continue;
    }
    if (section !== 'vars') continue;
    const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`));
    if (match) return match[1].trim().toLowerCase();
  }
  return null;
}

const siteSource = readFileSync(sitePath, 'utf8');
const siteProvider = requiredMatch(siteSource, /\bpgProvider\s*:\s*['"]([^'"]+)['"]/, 'site pgProvider');
const errors = [];

for (const configPath of workerConfigs) {
  const source = readFileSync(configPath, 'utf8');
  const provider = readVarsString(source, 'PG_PROVIDER');
  const siteMirror = readVarsString(source, 'SITE_PG_PROVIDER');
  const nicepayEnvironment = readVarsString(source, 'PG_NICEPAY_ENV');
  const configName = configPath.slice(repoRoot.length + 1);

  if (!provider) errors.push(`${configName}: PG_PROVIDER is missing from [vars]`);
  if (!siteMirror) errors.push(`${configName}: SITE_PG_PROVIDER is missing from [vars]`);
  if (provider && provider !== siteProvider) errors.push(`${configName}: PG_PROVIDER does not match site pgProvider`);
  if (siteMirror && siteMirror !== siteProvider) errors.push(`${configName}: SITE_PG_PROVIDER does not match site pgProvider`);
  if (provider && provider === 'nicepay' && nicepayEnvironment !== 'test') {
    errors.push(`${configName}: NICEPAY default must use PG_NICEPAY_ENV=test`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`payment provider config: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`payment provider config OK: site and ${workerConfigs.length} Worker targets use ${siteProvider}`);
}
