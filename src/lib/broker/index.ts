/**
 * Broker selection.
 *
 * `paper` is the default and requires no configuration, per BUILD_CONTRACT rule 3:
 * an absent API key is an unselected switch, never a broken deployment. Alpaca is
 * reachable only when it is *both* explicitly selected through `AURELIUS_BROKER`
 * and fully credentialed — either condition alone falls back to paper, because a
 * half-configured live venue is the one outcome that must never silently occur.
 *
 * The mandate also constrains how routes may be *described*: "if multiple API
 * routes are available they must be presented objectively without describing one
 * as the 'best price' or 'preferred' route", since doing so would assume the
 * broker-dealer duty of best execution. `brokerOptions()` therefore returns plain
 * capability facts with no ranking, no default emphasis and no recommendation.
 */

import {
  AlpacaBroker,
  ALPACA_KEY_ID_ENV,
  ALPACA_SECRET_ENV,
  alpacaCredentialsFromEnv,
} from '@/lib/broker/alpaca';
import { PaperBroker, type PaperBrokerOptions } from '@/lib/broker/paper';
import type { BrokerAdapter, BrokerDescriptor, BrokerName } from '@/lib/broker/types';

export * from '@/lib/broker/types';
export { PaperBroker, paperOrderId, outboundPayload } from '@/lib/broker/paper';
export {
  AlpacaBroker,
  alpacaCredentialsFromEnv,
  mapAlpacaStatus,
  mapAccountSnapshot,
  mapPosition,
  ALPACA_KEY_ID_ENV,
  ALPACA_SECRET_ENV,
  ALPACA_BASE_URL_ENV,
  ALPACA_PAPER_BASE_URL,
  ALPACA_TIMEOUT_MS,
} from '@/lib/broker/alpaca';

export const BROKER_SELECTION_ENV = 'AURELIUS_BROKER';

/** Names `AURELIUS_BROKER` accepts. Anything else falls back to paper. */
export const BROKER_NAMES: readonly BrokerName[] = ['paper', 'alpaca'];

export interface ResolveBrokerOptions {
  env?: NodeJS.ProcessEnv;
  /** Passed through when the paper broker is selected. */
  paper?: PaperBrokerOptions;
  clock?: () => number;
  fetchImpl?: typeof fetch;
}

export interface BrokerResolution {
  broker: BrokerAdapter;
  /** Which name was requested, before credentials were checked. */
  requested: BrokerName;
  /** Why the resolution landed where it did — surfaced on the admin panel. */
  reason:
    | 'default_paper'
    | 'selected_paper'
    | 'selected_alpaca'
    | 'alpaca_credentials_missing'
    | 'unknown_selection';
}

function parseSelection(raw: string | undefined): { name: BrokerName; recognised: boolean } {
  if (raw === undefined || raw.length === 0) return { name: 'paper', recognised: true };
  const normalised = raw.trim().toLowerCase();
  const match = BROKER_NAMES.find((name) => name === normalised);
  return match === undefined ? { name: 'paper', recognised: false } : { name: match, recognised: true };
}

/**
 * Resolves the adapter, reporting how it got there.
 *
 * Returns the reason alongside the adapter so an operator can see on the admin
 * surface that Alpaca was asked for and declined for want of credentials — a
 * silent downgrade to paper would be indistinguishable from a working live
 * configuration, which is a materially misleading state for a trading platform.
 */
export function resolveBrokerWithReason(options: ResolveBrokerOptions = {}): BrokerResolution {
  const env = options.env ?? process.env;
  const selection = parseSelection(env[BROKER_SELECTION_ENV]);

  const paperBroker = (): BrokerAdapter =>
    new PaperBroker({ clock: options.clock, ...options.paper });

  if (!selection.recognised) {
    console.warn(
      `[aurelius] ${BROKER_SELECTION_ENV}="${env[BROKER_SELECTION_ENV]}" is not one of ${BROKER_NAMES.join(', ')}; routing to the paper broker.`,
    );
    return { broker: paperBroker(), requested: 'paper', reason: 'unknown_selection' };
  }

  if (selection.name === 'alpaca') {
    const credentials = alpacaCredentialsFromEnv(env);
    if (credentials === null) {
      console.warn(
        `[aurelius] ${BROKER_SELECTION_ENV}=alpaca but ${ALPACA_KEY_ID_ENV} and ${ALPACA_SECRET_ENV} are not both set; routing to the paper broker.`,
      );
      return { broker: paperBroker(), requested: 'alpaca', reason: 'alpaca_credentials_missing' };
    }
    return {
      broker: new AlpacaBroker({
        credentials,
        clock: options.clock,
        fetchImpl: options.fetchImpl,
      }),
      requested: 'alpaca',
      reason: 'selected_alpaca',
    };
  }

  return {
    broker: paperBroker(),
    requested: 'paper',
    reason: env[BROKER_SELECTION_ENV] === undefined ? 'default_paper' : 'selected_paper',
  };
}

/** Resolves the adapter for this deployment. */
export function resolveBroker(options: ResolveBrokerOptions = {}): BrokerAdapter {
  return resolveBrokerWithReason(options).broker;
}

/**
 * Process-wide adapter.
 *
 * Cached so the paper broker's in-memory account survives across requests in a
 * single process — a fresh adapter per request would reset the sandbox balance on
 * every page load.
 */
let processBroker: BrokerAdapter | null = null;

export function getBroker(options: ResolveBrokerOptions = {}): BrokerAdapter {
  if (processBroker === null) processBroker = resolveBroker(options);
  return processBroker;
}

/** Installs a configured adapter (real ports) or clears it for tests. */
export function setBroker(broker: BrokerAdapter | null): void {
  processBroker = broker;
}

/**
 * Objective description of every route the deployment could use.
 *
 * Order is fixed and alphabetical by name, carries no emphasis, and the copy
 * states capabilities only — no route is labelled best, preferred, recommended or
 * fastest.
 */
export function brokerOptions(env: NodeJS.ProcessEnv = process.env): {
  descriptors: BrokerDescriptor[];
  active: BrokerName;
} {
  const resolution = resolveBrokerWithReason({ env });
  const descriptors: BrokerDescriptor[] = [
    new PaperBroker().describe(),
  ];
  const credentials = alpacaCredentialsFromEnv(env);
  if (credentials !== null) {
    descriptors.push(new AlpacaBroker({ credentials }).describe());
  }
  return { descriptors, active: resolution.broker.name };
}
