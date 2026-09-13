import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registryMediaUrl } from '../src/mediaUrl.ts';
test('токен добавляется только к картинкам VSpace', () => {
 const registry='https://registry.example/api/v1';
 assert.equal(registryMediaUrl('https://registry.example/media/123',registry),'https://registry.example/media/123');
 assert.equal(registryMediaUrl('https://registry.example/api/v1/media/123',registry),'https://registry.example/media/123');
 assert.equal(registryMediaUrl('/media/123',registry),'https://registry.example/media/123');
 assert.equal(registryMediaUrl('https://external.example/media/123',registry),null);
 assert.equal(registryMediaUrl('https://registry.example/api/v1/auth/me',registry),null);
});
