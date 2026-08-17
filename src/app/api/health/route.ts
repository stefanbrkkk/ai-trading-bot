/**
 * Liveness and configuration report.
 *
 * Deliberately verbose about *which* engine is serving each subsystem. The header
 * strip renders this, and a user is entitled to know whether the numbers in front
 * of them came from a live feed or from the deterministic simulator — presenting
 * synthetic data as live would be the kind of misrepresentation the AI-washing
 * rules exist to prevent.
 */

import { handler, ok } from '@/lib/api/respond';
import { isMarketOpen, sessionPhase } from '@/lib/market/calendar';
import { marketProviderStatus } from '@/lib/market/provider';
import { engineReadiness } from '@/lib/engine/service';
import { modelStatus } from '@/lib/engine/store';
import { dbMode, killSwitchState } from '@/lib/db';
import { aiStatus } from '@/lib/api/optional';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const now = Date.now();
  const market = marketProviderStatus();
  const engine = engineReadiness();
  const model = modelStatus();
  const ai = await aiStatus();
  const kill = safeKillSwitch();

  return ok({
    ok: true,
    now,
    marketOpen: isMarketOpen(now),
    marketPhase: sessionPhase(now),
    provider: market.name,
    providerLive: market.live,
    providerReason: market.reason,
    degradedFeeds: market.degradedFeeds,
    aiProvider: ai.provider,
    aiLive: ai.live,
    aiReason: ai.reason,
    dbMode: dbMode(),
    engineReady: engine.ready,
    engineReason: engine.reason,
    modelVersion: model.version,
    modelPresent: model.present,
    modelReason: model.reason,
    killSwitch: kill.engaged,
    killSwitchReason: kill.reason,
  });
});

function safeKillSwitch(): { engaged: boolean; reason: string | null } {
  try {
    const state = killSwitchState();
    return { engaged: state.engaged, reason: state.reason };
  } catch {
    return { engaged: false, reason: null };
  }
}
