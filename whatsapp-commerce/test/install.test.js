import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const { makeTenant } = await import('./helpers.js');
const { wordpressPlugin, crc32 } = await import('../src/install.js');

test('WordPress plugin zip: valid archive with the shop\'s chat script inside', () => {
  const t = makeTenant();
  const z = wordpressPlugin(t);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926); // standard CRC-32 check value
  const s = z.toString('utf8');
  assert.match(s, new RegExp(`/chat-widget/${t.id}\.js`));
  assert.match(s, /Plugin Name: /);
  assert.match(s, /ai-chat-assistant\/ai-chat-assistant\.php/);
  // if python is around, let a real unzip check it
  try {
    const out = execFileSync('python', ['-c', 'import sys,zipfile,io; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(z.testzip() or "ok", len(z.namelist()))'], { input: z }).toString().trim();
    assert.equal(out, 'ok 2');
  } catch (e) { if (e.code !== 'ENOENT' && !/not found|No such file/i.test(String(e.message))) throw e; }
});
