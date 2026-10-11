'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
test('queryTreeCandidate has CJS, ESM and root namespace entry points', async () => {
  const query = require('../queries').queryTreeCandidate
  assert.equal(typeof query, 'function')
  assert.equal(require('..').queries.queryTreeCandidate, query)
  assert.equal((await import('../queries.mjs')).queryTreeCandidate, query)
})
