'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAsyncCache } = require('../lib/cache');

test('deduplica carregamentos concorrentes e serve hit dentro do TTL', async () => {
  let calls = 0;
  let release;
  let clock = Date.parse('2026-08-27T10:00:00Z');
  const gate = new Promise(resolve => { release = resolve; });
  const cache = createAsyncCache(async () => {
    calls++;
    await gate;
    return `valor-${calls}`;
  }, { ttlMs: 1000, now: () => clock });

  const first = cache.get();
  const concurrent = cache.get();
  await Promise.resolve();
  assert.equal(calls, 1);
  release();

  const [a, b] = await Promise.all([first, concurrent]);
  assert.equal(a.value, 'valor-1');
  assert.equal(a.cache, 'miss');
  assert.deepEqual(b, a);

  clock += 999;
  const hit = await cache.get();
  assert.equal(hit.cache, 'hit');
  assert.equal(calls, 1);
});

test('após expirar, preserva o último valor como stale se a atualização falhar', async () => {
  let clock = 1000;
  let calls = 0;
  const cache = createAsyncCache(async () => {
    calls++;
    if (calls > 1) throw new Error('Dropbox indisponível');
    return 'base válida';
  }, { ttlMs: 50, now: () => clock });

  const fresh = await cache.get();
  assert.equal(fresh.stale, false);
  clock += 51;

  const stale = await cache.get();
  assert.equal(stale.value, 'base válida');
  assert.equal(stale.cache, 'stale');
  assert.equal(stale.stale, true);
  assert.equal(stale.refreshError, 'Dropbox indisponível');
  assert.equal(calls, 2);

  clock += 10;
  const cooldown = await cache.get();
  assert.equal(cooldown.cache, 'hit');
  assert.equal(cooldown.stale, true);
  assert.equal(calls, 2);
});

test('propaga a primeira falha e clear obriga novo carregamento', async () => {
  let calls = 0;
  const failing = createAsyncCache(async () => {
    calls++;
    throw new Error('sem base');
  });
  await assert.rejects(failing.get(), /sem base/);

  let value = 0;
  const cache = createAsyncCache(async () => ++value, { ttlMs: 1000 });
  assert.equal((await cache.get()).value, 1);
  cache.clear();
  assert.equal((await cache.get()).value, 2);
});
