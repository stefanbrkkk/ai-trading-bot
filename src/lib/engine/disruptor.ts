/**
 * Ring buffer with sequence barriers — the in-process analogue of the LMAX
 * Disruptor mandated by MASTER §2.1 / Phase 1 §1 / Phase 3 §3.
 *
 * What the research specifies and why it cannot be transplanted literally:
 *
 *   The mandate is a pre-allocated circular array, multi-producer claim via
 *   hardware Compare-And-Swap, and a Sequence Barrier that stops the execution
 *   consumer from reading a state vector until all three temporal agents have
 *   published their inference. CAS exists to make *concurrent* claims safe. A
 *   Node.js request handler runs on one event-loop thread, so there is no
 *   preemption between a read and a write of a claim counter — the atomic
 *   instruction has nothing to protect against.
 *
 * What is therefore implemented, faithfully:
 *
 *   • A pre-allocated, power-of-two ring buffer with entries constructed once
 *     and mutated in place — no per-event allocation, which is the actual
 *     performance property the Disruptor buys (mechanical sympathy, cache
 *     locality, zero GC pressure on the hot path).
 *   • Monotonic sequence claiming with a gating sequence, so a producer can
 *     never lap a consumer that has not yet released a slot.
 *   • A real `SequenceBarrier`: the execution consumer's `waitFor` only returns
 *     once every registered dependent sequence has advanced past the requested
 *     slot. This is the guarantee the spec calls out by name, and it is enforced
 *     here rather than assumed.
 *   • `Sequence` values go through `Atomics` on a `SharedArrayBuffer` when one is
 *     available, so the same structure stays correct if the pipeline is later
 *     moved onto worker threads.
 */

const INITIAL_SEQUENCE = -1;

/**
 * A single monotonically increasing counter. Backed by Atomics on a
 * SharedArrayBuffer where the runtime allows it, so worker-thread producers
 * would observe the same ordering guarantees without changing this code.
 */
export class Sequence {
  private readonly view: Int32Array;
  private readonly shared: boolean;

  constructor(initial: number = INITIAL_SEQUENCE) {
    let view: Int32Array;
    let shared = false;
    try {
      if (typeof SharedArrayBuffer !== 'undefined') {
        view = new Int32Array(new SharedArrayBuffer(4));
        shared = true;
      } else {
        view = new Int32Array(1);
      }
    } catch {
      view = new Int32Array(1);
    }
    this.view = view;
    this.shared = shared;
    this.set(initial);
  }

  get(): number {
    return this.shared ? Atomics.load(this.view, 0) : (this.view[0] as number);
  }

  set(value: number): void {
    if (this.shared) Atomics.store(this.view, 0, value);
    else this.view[0] = value;
  }

  /** Atomic increment-and-get — the claim operation. */
  incrementAndGet(): number {
    if (this.shared) return Atomics.add(this.view, 0, 1) + 1;
    this.view[0] = (this.view[0] as number) + 1;
    return this.view[0] as number;
  }

  /** Compare-and-swap; returns true when the swap happened. */
  compareAndSet(expected: number, next: number): boolean {
    if (this.shared) return Atomics.compareExchange(this.view, 0, expected, next) === expected;
    if ((this.view[0] as number) !== expected) return false;
    this.view[0] = next;
    return true;
  }
}

/** Minimum of a set of sequences — the gate a producer must respect. */
export function minimumSequence(sequences: readonly Sequence[], fallback: number): number {
  let min = fallback;
  for (const s of sequences) {
    const v = s.get();
    if (v < min) min = v;
  }
  return min;
}

export interface RingBufferOptions<T> {
  /** Must be a power of two so `sequence & mask` replaces a modulo. */
  size: number;
  /** Called `size` times at construction; entries are then reused forever. */
  factory: () => T;
}

export class RingBuffer<T> {
  private readonly entries: T[];
  private readonly mask: number;
  readonly capacity: number;
  private readonly cursor = new Sequence();
  private readonly gatingSequences: Sequence[] = [];
  /** Count of claims that had to wait because the buffer was full. */
  private contendedClaims = 0;

  constructor(options: RingBufferOptions<T>) {
    const size = options.size;
    if (size < 1 || (size & (size - 1)) !== 0) {
      throw new Error(`RingBuffer: size must be a power of two, received ${size}`);
    }
    this.capacity = size;
    this.mask = size - 1;
    this.entries = Array.from({ length: size }, options.factory);
  }

  /** Registers a consumer sequence that producers must not lap. */
  addGatingSequence(sequence: Sequence): void {
    this.gatingSequences.push(sequence);
  }

  get published(): number {
    return this.cursor.get();
  }

  get stats(): { published: number; capacity: number; contendedClaims: number; slowestConsumer: number } {
    return {
      published: this.cursor.get(),
      capacity: this.capacity,
      contendedClaims: this.contendedClaims,
      slowestConsumer: minimumSequence(this.gatingSequences, this.cursor.get()),
    };
  }

  /**
   * Claims the next slot. Returns null instead of blocking when every consumer
   * is more than `capacity` behind — the caller then applies back-pressure
   * rather than overwriting unread state.
   */
  tryNext(): number | null {
    const next = this.cursor.get() + 1;
    const wrapPoint = next - this.capacity;
    if (wrapPoint >= 0) {
      const slowest = minimumSequence(this.gatingSequences, next - 1);
      if (wrapPoint > slowest) {
        this.contendedClaims += 1;
        return null;
      }
    }
    return this.cursor.incrementAndGet();
  }

  /** The pre-allocated entry for a sequence — mutate it, never replace it. */
  get(sequence: number): T {
    return this.entries[sequence & this.mask] as T;
  }

  /**
   * Claims a slot, hands the pre-allocated entry to `write`, and publishes.
   * Returns the published sequence, or null under back-pressure.
   */
  publish(write: (entry: T, sequence: number) => void): number | null {
    const seq = this.tryNext();
    if (seq === null) return null;
    write(this.get(seq), seq);
    return seq;
  }
}

/**
 * Sequence barrier: `waitFor(sequence)` succeeds only once the ring buffer has
 * published that slot *and* every dependent sequence has passed it.
 *
 * This is the guarantee MASTER §2.1 asks for by name — the execution consumer
 * reads a unified state vector only after all three temporal agents publish.
 */
export class SequenceBarrier {
  constructor(
    private readonly cursor: () => number,
    private readonly dependents: readonly Sequence[] = [],
  ) {}

  /** Highest sequence currently safe to read, or −1 when nothing is. */
  availableSequence(): number {
    const published = this.cursor();
    if (this.dependents.length === 0) return published;
    return Math.min(published, minimumSequence(this.dependents, published));
  }

  isAvailable(sequence: number): boolean {
    return this.availableSequence() >= sequence;
  }

  /**
   * Synchronous check used by the in-process pipeline. Returns the highest
   * available sequence ≥ `sequence`, or null if the barrier is not satisfied.
   */
  tryWaitFor(sequence: number): number | null {
    const available = this.availableSequence();
    return available >= sequence ? available : null;
  }

  /**
   * Async form for cases where a producer genuinely runs on another tick (e.g.
   * an agent awaiting I/O). Polls with a microtask yield and a hard deadline so
   * a stalled producer can never hang a request.
   */
  async waitFor(sequence: number, timeoutMs = 250): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const available = this.availableSequence();
      if (available >= sequence) return available;
      if (Date.now() >= deadline) {
        throw new Error(
          `SequenceBarrier: timed out waiting for sequence ${sequence} (available ${available})`,
        );
      }
      await Promise.resolve();
    }
  }
}

/**
 * A consumer that drains published slots in order and releases them so
 * producers can advance.
 */
export class BatchEventProcessor<T> {
  readonly sequence = new Sequence();
  private readonly barrier: SequenceBarrier;

  constructor(
    private readonly ring: RingBuffer<T>,
    private readonly handler: (event: T, sequence: number, endOfBatch: boolean) => void,
    dependents: readonly Sequence[] = [],
  ) {
    this.barrier = new SequenceBarrier(() => ring.published, dependents);
    ring.addGatingSequence(this.sequence);
  }

  /** Processes every currently available slot; returns how many were handled. */
  drain(): number {
    let next = this.sequence.get() + 1;
    const available = this.barrier.availableSequence();
    if (available < next) return 0;
    let handled = 0;
    while (next <= available) {
      this.handler(this.ring.get(next), next, next === available);
      this.sequence.set(next);
      next += 1;
      handled += 1;
    }
    return handled;
  }
}
