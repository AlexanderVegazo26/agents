// Enlaces externos: el host mostrado debe ser el host real (revisión de seguridad N3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ URL });
vm.runInContext(readFileSync(new URL('../public/js/url.js', import.meta.url), 'utf8'), ctx, { filename: 'url.js' });
const { OBUrl } = ctx;
const BS = String.fromCharCode(92);

test('rechaza credenciales o separadores engañosos en la autoridad (cuatro casos de la revisión)', () => {
  for (const u of [
    'https://www.homecenter.com.co@evil.com/x',
    'https://www.homecenter.com.co:443@evil.com/x',
    'https://www.homecenter.com.co%2F@evil.com/x',
    'https://evil.com' + BS + 'www.homecenter.com.co/x'
  ]) {
    assert.equal(OBUrl.safeUrl(u), null, u);
    assert.equal(OBUrl.hostOf(u), null, u);
  }
});

test('rechaza esquemas que no son https, espacios y caracteres de control', () => {
  for (const u of ['http://www.homecenter.com.co/x', 'javascript:alert(1)', 'https://a b.com/', 'https://a.com/' + String.fromCharCode(9), '']) {
    assert.equal(OBUrl.safeUrl(u), null, JSON.stringify(u));
  }
});

test('acepta un enlace https normal y muestra su host real', () => {
  const u = 'https://www.homecenter.com.co/homecenter-co/product/876926/';
  assert.equal(OBUrl.safeUrl(u), u);
  assert.equal(OBUrl.hostOf(u), 'www.homecenter.com.co');
  assert.equal(OBUrl.hostOf('https://WWW.Vialambre.com/x?a=1@2'), 'www.vialambre.com');
});
