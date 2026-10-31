'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dedupeCsv } = require('./dedupe');

describe('dedupeCsv', () => {
  it('keeps first row per email, case-insensitive', () => {
    const input = 'name,email\nAlice,a@x.com\nBob,A@X.com\nCara,c@x.com\n';
    const out = dedupeCsv(input);
    assert.equal(out, 'name,email\nAlice,a@x.com\nCara,c@x.com\n');
  });

  it('throws when email column is missing', () => {
    assert.throws(() => dedupeCsv('name,phone\na,1\n'), /email column/);
  });
});
