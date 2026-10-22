'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { strictSsl } = require('../../lib/store');

test('adresse Neon : sslmode=require devient verify-full (certificat vérifié, plus d’avertissement)', () => {
  assert.equal(strictSsl('postgresql://u:p@h/db?sslmode=require&channel_binding=require'), 'postgresql://u:p@h/db?sslmode=verify-full&channel_binding=require');
  assert.equal(strictSsl('postgresql://u:p@h/db?channel_binding=require&sslmode=prefer'), 'postgresql://u:p@h/db?channel_binding=require&sslmode=verify-full');
  assert.equal(strictSsl('postgres://u@127.0.0.1/db'), 'postgres://u@127.0.0.1/db', 'sans sslmode : inchangée');
  assert.equal(strictSsl('postgresql://h/db?sslmode=disable'), 'postgresql://h/db?sslmode=disable');
});
