import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { UserStore } from '../src/user-store.js';

test('用户密码以强哈希保存且支持重置密码', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quantflow-users-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'users.json');
  const store = new UserStore(filePath, { iterations: 1_000 });

  assert.deepEqual(await store.initialize(), { setupRequired: true, bootstrapped: false });
  await store.initialize({ username: 'admin', password: 'AdminPass-2026', displayName: '管理员' });
  const created = await store.create({ username: 'analyst', displayName: '分析员', password: 'AnalystPass-2026', role: 'user' });
  assert.equal((await store.authenticate('ANALYST', 'AnalystPass-2026')).id, created.id);

  const persisted = await fs.readFile(filePath, 'utf8');
  assert.doesNotMatch(persisted, /AnalystPass-2026/);
  assert.match(persisted, /pbkdf2-sha256/);

  await store.resetPassword(created.id, 'NewAnalyst-2026');
  await assert.rejects(store.authenticate('analyst', 'AnalystPass-2026'), /账号或密码错误/);
  assert.equal((await store.authenticate('analyst', 'NewAnalyst-2026')).id, created.id);
});
