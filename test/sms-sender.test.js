/* Texts go out from the alphanumeric sender ID ECHELON — node --test */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

function freshSms(env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  delete require.cache[require.resolve('../sms.js')];
  try { return require('../sms.js'); } finally { process.env = saved; delete require.cache[require.resolve('../sms.js')]; }
}

async function sentForm(env) {
  const sms = freshSms({ SMS_LIVE: 'on', TWILIO_ACCOUNT_SID: 'ACx', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM_NUMBER: '+447700900000', ...env });
  const realFetch = global.fetch;
  let form;
  global.fetch = async (_url, opts) => { form = opts.body; return { ok: true, json: async () => ({ sid: 'SM1', status: 'queued' }) }; };
  try { assert.equal((await sms.send({ to: '07700 900111', body: 'hi' })).ok, true); } finally { global.fetch = realFetch; }
  return form;
}

test('sends from ECHELON by default, even when a number is configured', async () => {
  const form = await sentForm({ SMS_SENDER_ID: undefined, TWILIO_MESSAGING_SERVICE_SID: 'MGx' });
  assert.equal(form.get('From'), 'ECHELON');
  assert.equal(form.get('MessagingServiceSid'), null);
});

test('an empty SMS_SENDER_ID falls back to the number', async () => {
  const form = await sentForm({ SMS_SENDER_ID: '' });
  assert.equal(form.get('From'), '+447700900000');
});

test('sender IDs Twilio would reject are not used', () => {
  const { senderIdFrom } = freshSms({});
  assert.equal(senderIdFrom(undefined), 'ECHELON');
  assert.equal(senderIdFrom('Echelon CIC'), 'Echelon CIC');
  assert.equal(senderIdFrom('TWELVECHARSX'), '');
  assert.equal(senderIdFrom('12345'), '');
  assert.equal(senderIdFrom('ECH-ELON'), '');
});
