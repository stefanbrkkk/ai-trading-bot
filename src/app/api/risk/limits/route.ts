/**
 * The published risk limits.
 *
 * Every control is exposed with its value, its unit and its regulatory basis. A
 * user is entitled to know the exact ceiling that will reject their order before
 * they type it — a limit discovered only by hitting it is a usability failure and,
 * in this domain, an accountability one.
 */

import { handler, ok } from '@/lib/api/respond';
import { RISK_LIMIT_DESCRIPTORS } from '@/lib/risk';
import { killSwitchState } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  let engaged = false;
  try {
    engaged = killSwitchState().engaged;
  } catch {
    engaged = false;
  }
  return ok({ limits: RISK_LIMIT_DESCRIPTORS, killSwitchEngaged: engaged });
});
