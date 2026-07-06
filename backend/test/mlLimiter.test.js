/**
 * Tests del circuit breaker del limitador de ML (mlLimiter.js).
 * Cubre: umbral de 429 consecutivos que abre el circuito, escalada del cooldown,
 * y reset al primer éxito. Se configuran las envs antes de importar el módulo.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let mlLimiter;

before(async () => {
  process.env.ML_CIRCUIT_THRESHOLD = '3';
  process.env.ML_CIRCUIT_BASE_MS = '30000';
  process.env.ML_CIRCUIT_MAX_MS = '300000';
  mlLimiter = await import('../src/lib/mlLimiter.js');
});

test('circuit breaker: no abre antes del umbral de 429 consecutivos', () => {
  mlLimiter.recordMlOk(); // reset
  assert.equal(mlLimiter.recordMl429(), 0); // 1
  assert.equal(mlLimiter.recordMl429(), 0); // 2
  const stats = mlLimiter.mlLimiterStats();
  assert.equal(stats.circuitLevel, 0);
  assert.equal(stats.consecutive429, 2);
});

test('circuit breaker: al cruzar el umbral abre y pausa el caño con el cooldown base', () => {
  mlLimiter.recordMlOk(); // reset
  mlLimiter.recordMl429(); // 1
  mlLimiter.recordMl429(); // 2
  const cooldown = mlLimiter.recordMl429(); // 3 → abre
  assert.equal(cooldown, 30000);
  const stats = mlLimiter.mlLimiterStats();
  assert.equal(stats.circuitLevel, 1);
  assert.equal(stats.consecutive429, 0); // se reseteó al abrir
  assert.ok(stats.pausedForMs > 25000, `esperaba pausa ~30s, fue ${stats.pausedForMs}ms`);
});

test('circuit breaker: en recuperación (circuitLevel>0) un solo 429 reabre con cooldown escalado', () => {
  mlLimiter.recordMlOk(); // reset
  mlLimiter.recordMl429();
  mlLimiter.recordMl429();
  assert.equal(mlLimiter.recordMl429(), 30000); // abre nivel 1
  // Ya en recuperación: un solo 429 reabre, esta vez el doble.
  assert.equal(mlLimiter.recordMl429(), 60000);
  assert.equal(mlLimiter.recordMl429(), 120000);
  assert.equal(mlLimiter.mlLimiterStats().circuitLevel, 3);
});

test('circuit breaker: el cooldown se topa en ML_CIRCUIT_MAX_MS', () => {
  mlLimiter.recordMlOk(); // reset
  mlLimiter.recordMl429();
  mlLimiter.recordMl429();
  let last = mlLimiter.recordMl429(); // abre
  for (let i = 0; i < 12; i++) last = mlLimiter.recordMl429();
  assert.equal(last, 300000); // topado en el máximo
});

test('circuit breaker: un éxito cierra el circuito y resetea la escalada', () => {
  mlLimiter.recordMlOk(); // reset
  mlLimiter.recordMl429();
  mlLimiter.recordMl429();
  mlLimiter.recordMl429(); // abre
  assert.equal(mlLimiter.mlLimiterStats().circuitLevel, 1);
  mlLimiter.recordMlOk();
  const stats = mlLimiter.mlLimiterStats();
  assert.equal(stats.circuitLevel, 0);
  assert.equal(stats.consecutive429, 0);
  // Tras el reset, vuelve a hacer falta cruzar el umbral completo para reabrir.
  assert.equal(mlLimiter.recordMl429(), 0);
  assert.equal(mlLimiter.recordMl429(), 0);
});
