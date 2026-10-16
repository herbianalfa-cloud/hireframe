// Must stay the first import: global options apply only to functions defined after it.
import '../options.js';

import { scheduler } from 'node:timers/promises';

import { CALLABLE_TIMEOUT_SECONDS } from '@hireframe/shared';
import { onMessagePublished } from 'firebase-functions/pubsub';

import { BILLING_GUARD, guardMode, REGION } from '../config.js';
import { log } from '../log.js';
import { createBillingClient } from './client.js';
import { runGuard } from './handler.js';

/**
 * billingGuard (ADR-059): the billing kill switch. Triggered only by the `hireframe-kill`
 * budget's Pub/Sub notifications, a message this function cannot cause: it publishes nothing,
 * writes nothing and re-enqueues nothing. Runs as its own account (no Firestore access, no
 * secrets), one instance, no platform retry. In dry run (the default) it makes no network call.
 */
export const billingGuard = onMessagePublished(
  {
    topic: BILLING_GUARD.topic,
    region: REGION,
    serviceAccount: BILLING_GUARD.serviceAccount,
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.billingGuard,
    memory: '256MiB',
    // Stated here, not only inherited from the global options.
    maxInstances: 1,
    retry: false,
  },
  async (event) => {
    await runGuard(event.data.message.data, {
      mode: guardMode(process.env),
      billing: () =>
        createBillingClient({
          // Looked up per call, so a test can stand in for the global fetch.
          fetch: (input, init) => globalThis.fetch(input, init),
          now: () => Date.now(),
          // Backoff between retries of one request, never a way to run again later.
          sleep: (ms) => scheduler.wait(ms),
          random: () => Math.random(),
          log: (level, event, fields) => {
            log[level](event, fields);
          },
          deadline: Date.now() + BILLING_GUARD.deadlineMs,
        }),
    });
  },
);
