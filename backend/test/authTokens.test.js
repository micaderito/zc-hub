/**
 * Tests de lib/authTokens.js: hash/verify de contraseña (scrypt) y firma/verificación de JWT.
 * Fija AUTH_JWT_SECRET antes de importar el módulo para poder forjar tokens de prueba con el
 * mismo secreto (el módulo cachea un secreto aleatorio si la variable no está seteada).
 */
process.env.AUTH_JWT_SECRET = 'test-secret-authTokens';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { hashPassword, verifyPassword, signToken, verifyToken, daysUntilExpiry } from '../src/lib/authTokens.js';

test('hashPassword produce un hash distinto cada vez (salt aleatorio) pero ambos verifican', () => {
  const a = hashPassword('miContraseña123');
  const b = hashPassword('miContraseña123');
  assert.notEqual(a, b);
  assert.equal(verifyPassword('miContraseña123', a), true);
  assert.equal(verifyPassword('miContraseña123', b), true);
});

test('verifyPassword rechaza una contraseña incorrecta', () => {
  const hash = hashPassword('correcta123');
  assert.equal(verifyPassword('incorrecta123', hash), false);
});

test('verifyPassword no tira excepción con un hash mal formado o vacío', () => {
  assert.equal(verifyPassword('algo', ''), false);
  assert.equal(verifyPassword('algo', 'no-es-un-hash-scrypt'), false);
  assert.equal(verifyPassword('algo', null), false);
  assert.equal(verifyPassword('algo', undefined), false);
});

test('signToken + verifyToken: viaje completo ida y vuelta', () => {
  const token = signToken({ id: 7, username: 'mica', tokenVersion: 1 });
  const payload = verifyToken(token);
  assert.equal(payload.id, 7);
  assert.equal(payload.username, 'mica');
  assert.equal(payload.tokenVersion, 1);
  assert.ok(payload.expiresAt > Date.now());
});

test('verifyToken devuelve null ante un token con firma adulterada', () => {
  const token = signToken({ id: 1, username: 'x', tokenVersion: 1 });
  const tampered = token.slice(0, -3) + (token.endsWith('a') ? 'bcd' : 'abc');
  assert.equal(verifyToken(tampered), null);
});

test('verifyToken devuelve null ante basura / string vacío', () => {
  assert.equal(verifyToken(''), null);
  assert.equal(verifyToken('no.es.un.jwt'), null);
  assert.equal(verifyToken(undefined), null);
});

test('verifyToken devuelve null ante un token vencido', () => {
  const expired = jwt.sign({ sub: 1, username: 'x', tv: 1 }, 'test-secret-authTokens', { expiresIn: -10 });
  assert.equal(verifyToken(expired), null);
});

test('daysUntilExpiry: negativo si ya venció, positivo si falta', () => {
  assert.ok(daysUntilExpiry(Date.now() - 1000) < 0);
  assert.ok(daysUntilExpiry(Date.now() + 10 * 24 * 60 * 60 * 1000) > 9);
  assert.equal(daysUntilExpiry(null), 0);
  assert.equal(daysUntilExpiry(0), 0);
});
