import assert from 'node:assert/strict';
import test from 'node:test';
import { ticketFromScan } from '../client/src/scanner.ts';

// A camera reads whatever is in front of it, including QR codes from the wider world. What
// matters is that our tickets are recognised from any origin, and that everything else is
// rejected rather than sent to the server as a guess.

const TOKEN = '5Mt4wZCjMJJM3aI2WgzK7A'; // 22 chars of base64url, as randomBytes(16) produces

test('reads the token out of a scan-landing URL', () => {
  assert.deepEqual(ticketFromScan(`http://192.168.1.42:3001/t/${TOKEN}`), { token: TOKEN });
});

test('reads the token out of a customer order URL too', () => {
  assert.deepEqual(ticketFromScan(`https://pizza.example.com/order/${TOKEN}`), { token: TOKEN });
});

// THE POINT OF IGNORING THE ORIGIN: a ticket saved when the Pi had a different address, or
// before https, is still that guest's ticket. Refusing it would break exactly the ticket
// most in need of help.
test('the origin is ignored entirely', () => {
  for (const origin of [
    'http://10.0.0.5:3001',
    'https://pizza.example.com',
    'http://raspberrypi.local:3001',
  ]) {
    assert.deepEqual(ticketFromScan(`${origin}/t/${TOKEN}`), { token: TOKEN });
  }
});

test('tolerates a trailing slash and surrounding whitespace', () => {
  assert.deepEqual(ticketFromScan(`  http://x/t/${TOKEN}/  `), { token: TOKEN });
});

test('accepts a bare token', () => {
  assert.deepEqual(ticketFromScan(TOKEN), { token: TOKEN });
});

test('accepts a pickup code, normalised', () => {
  assert.deepEqual(ticketFromScan('k7m-2q'), { code: 'K7M2Q' });
});

test('rejects anything that is not ours rather than guessing', () => {
  for (const junk of [
    'https://example.com',
    'WIFI:S:PizzaNight;T:WPA;P:hunter2;;', // the other QR most likely to be on a wall
    'tel:+4915112345678',
    'BEGIN:VCARD\nEND:VCARD',
    '',
    '   ',
    'http://x/t/short',
    // A pickup code cannot contain O, I, 0 or 1, so this is not one either.
    'K7M2O',
  ]) {
    assert.equal(ticketFromScan(junk), null, `${JSON.stringify(junk)} should not resolve`);
  }
});

test('a /t/ URL with a query or fragment is not mistaken for a token', () => {
  // The anchored pattern means these fail closed rather than capturing junk.
  assert.equal(ticketFromScan(`http://x/t/${TOKEN}?utm=1`), null);
});
