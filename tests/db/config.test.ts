import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Minimal indentation-aware YAML reader: enough to assert compose structure
// without adding a YAML dependency (package.json is controller-owned).
type ComposeNode = Record<string, unknown>;

function indentOf(line: string): number {
  return line.length - line.replace(/^\s+/, '').length;
}

function parseBlock(lines: string[], start: number, indent: number): [ComposeNode, number] {
  const out: ComposeNode = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i += 1;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) {
      throw new Error(`Unexpected indentation at line ${i + 1}: ${line}`);
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      throw new Error(`Unexpected sequence item at compose line ${i + 1}`);
    }
    const match = trimmed.match(/^([\w.\-/"${}]+):\s*(.*)$/);
    if (!match) throw new Error(`Unparsed compose line ${i + 1}: ${line}`);
    const key = match[1];
    const value = match[2].trim();
    if (value !== '') {
      out[key] = value.replace(/^["']|["']$/g, '');
      i += 1;
      continue;
    }
    const nextNonEmpty = lines.slice(i + 1).find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    if (nextNonEmpty === undefined || indentOf(nextNonEmpty) <= indent) {
      out[key] = null;
      i += 1;
      continue;
    }
    const childIndent = indentOf(nextNonEmpty);
    if (nextNonEmpty.trim().startsWith('- ')) {
      const items: unknown[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const itemLine = lines[j];
        if (itemLine.trim() === '' || itemLine.trim().startsWith('#')) {
          j += 1;
          continue;
        }
        if (indentOf(itemLine) < childIndent || !itemLine.trim().startsWith('- ')) break;
        items.push(itemLine.trim().slice(2).replace(/^["']|["']$/g, ''));
        j += 1;
      }
      out[key] = items;
      i = j;
    } else {
      const [child, next] = parseBlock(lines, i + 1, childIndent);
      out[key] = child;
      i = next;
    }
  }
  return [out, i];
}

function parseCompose(raw: string): ComposeNode {
  const lines = raw.split(/\r?\n/);
  const [root] = parseBlock(lines, 0, 0);
  return root;
}

function asNode(value: unknown): ComposeNode {
  assert.ok(value && typeof value === 'object', 'expected a compose mapping');
  return value as ComposeNode;
}

const worktree = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../..');
const composeRaw = fs.readFileSync(path.join(worktree, 'docker-compose.yml'), 'utf-8');
const envRaw = fs.readFileSync(path.join(worktree, '.env.example'), 'utf-8');

test('docker-compose.yml parses and defines a Postgres 17 database service', () => {
  const compose = parseCompose(composeRaw);
  const services = asNode(compose.services);
  const db = asNode(services['slabswarm-db']);
  assert.match(String(db.image), /^postgres:17/, 'database must pin Postgres 17');
  assert.equal(db.restart, 'unless-stopped');
});

test('database service has a named volume and a pg_isready healthcheck', () => {
  const compose = parseCompose(composeRaw);
  const services = asNode(compose.services);
  const db = asNode(services['slabswarm-db']);
  const volumes = db.volumes as unknown[];
  assert.ok(Array.isArray(volumes), 'db must declare volumes');
  assert.ok(
    volumes.some((v) => String(v).startsWith('slabswarm-db-data:')),
    'db must use the named slabswarm-db-data volume',
  );
  assert.ok(compose.volumes && 'slabswarm-db-data' in asNode(compose.volumes));
  const healthcheck = asNode(db.healthcheck);
  assert.match(String(healthcheck.test ?? ''), /pg_isready/);
});

test('database is limited to 1 GB and is not published to any host port', () => {
  const compose = parseCompose(composeRaw);
  const db = asNode(asNode(compose.services)['slabswarm-db']);
  assert.ok(!('ports' in db), 'Postgres must not publish host ports');
  const deploy = asNode(db.deploy);
  const resources = asNode(deploy.resources);
  const limits = asNode(resources.limits);
  assert.equal(limits.memory, '1g');
});

test('database attaches only to an internal network shared with the app', () => {
  const compose = parseCompose(composeRaw);
  const services = asNode(compose.services);
  const db = asNode(services['slabswarm-db']);
  const app = asNode(services.slabswarm);
  assert.deepEqual(Object.keys(asNode(db.networks)), ['slabswarm-internal']);
  assert.ok('slabswarm-internal' in asNode(app.networks), 'app must share the internal network');
  const networks = asNode(compose.networks);
  assert.equal(asNode(networks['slabswarm-internal']).internal, 'true');
});

test('.env.example documents all non-secret Postgres configuration keys', () => {
  for (const key of ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PORT', 'DATABASE_URL']) {
    const line = envRaw.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    assert.ok(line, `${key} must be present in .env.example`);
    assert.ok(line.length > key.length + 1, `${key} must have an example value`);
  }
  const port = envRaw.match(/^POSTGRES_PORT=(.*)$/m)?.[1];
  assert.equal(port, '5432');
  const dsn = envRaw.match(/^DATABASE_URL=(.*)$/m)?.[1] ?? '';
  assert.match(dsn, /postgresql:\/\//, 'DATABASE_URL must be a Postgres DSN');
  assert.match(dsn, /@slabswarm-db:5432\//, 'DATABASE_URL must target the internal service');
});
