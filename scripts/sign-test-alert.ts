/**
 * Posts a fake alert email, signed with the local placeholder secret, to the Functions emulator's
 * `ingestEmailJobs` (ADR-046), so `npm run dev` can show the Gmail bridge's path without Gmail:
 *
 *   node scripts/sign-test-alert.ts            # the fake LinkedIn alert
 *   node scripts/sign-test-alert.ts waas       # the fake Work at a Startup digest (model fallback)
 *   node scripts/sign-test-alert.ts --twice    # the same signed request twice: the second is a replay
 *   node scripts/sign-test-alert.ts --id abc   # another Gmail message ID (a new message, new jobs)
 *
 * It only talks to localhost, and the secret is the emulator's placeholder, never a real one.
 */
import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';

import { LINKEDIN_ALERT, WAAS_ALERT } from '../packages/shared/src/fixtures/alerts.ts';
import { signingString } from '../packages/shared/src/signing.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const host = process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001';
if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
  throw new Error(`Refusing to post to ${host}: this tool only talks to the local emulator.`);
}
const project = process.env.GCLOUD_PROJECT ?? 'demo-hireframe';
if (!project.startsWith('demo-')) throw new Error('Refusing: not a demo-* project.');
const url = `http://${host}/${project}/europe-west2/ingestEmailJobs`;

// The emulator's secrets are placeholders (scripts/prepare-dev-functions.ts).
const SECRET = 'emulator-placeholder';

const fixture = args.includes('waas') ? WAAS_ALERT : LINKEDIN_ALERT;
const body = JSON.stringify({
  messages: [
    {
      id: option('--id') ?? 'dev-alert-1',
      receivedAt: new Date().toISOString(),
      ...fixture,
    },
  ],
});
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomUUID();
const signature = createHmac('sha256', SECRET)
  .update(signingString(timestamp, nonce, body), 'utf8')
  .digest('hex');

async function post(label: string): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hireframe-Timestamp': timestamp,
      'X-Hireframe-Nonce': nonce,
      'X-Hireframe-Signature': signature,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  console.log(`${label}: ${String(response.status)} ${await response.text()}`);
}

await post('first post');
if (flag('--twice')) await post('same request again (a replay)');
