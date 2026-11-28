import assert from 'node:assert';
import * as C from '/tmp/catalog.mjs';
assert.equal(Object.keys(C.CURRENCIES).length, 20);
assert(C.isCurrency('eur') && C.isMetal('Gold') && !C.isCurrency('GOLD') && !C.isMetal('EUR'));
assert.equal(C.labelOf('ANTX'), 'Anthropic'); assert.equal(C.labelOf('JPY'), 'Japanese yen'); assert.equal(C.labelOf('XYZ'), '');
assert.equal(C.groupOf('CHF'), 'currencies'); assert.equal(C.groupOf('PLATINUM'), 'metals'); assert.equal(C.groupOf('LUMA'), '');
console.log('catalog.ts ok');
