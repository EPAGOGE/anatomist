// Runtime AI-boundary guard. Belt-and-suspenders enforcement for ADR-0008.
//
// ADR-0008 forbids @epagoge/ai from being invoked anywhere on the
// reliability path (signature verification, chain-head computation,
// budget enforcement decisions). The ESLint rule blocks this at build
// time; this module blocks it at runtime by maintaining a thread-local
// "reliability scope" flag.
//
// Usage in reliability-bearing code:
//
//   import { withinReliabilityScope } from '@epagoge/ai';
//   const head = await withinReliabilityScope('verify-chain', async () => {
//     return ledger.verifyChain(...);
//   });
//
// Usage in @epagoge/ai entry points:
//
//   assertNotInReliabilityScope('anthropic-client.createMessage');

import { AsyncLocalStorage } from 'node:async_hooks';

interface ReliabilityFrame {
  readonly label: string;
  readonly enteredAt: number;
}

const storage = new AsyncLocalStorage<ReliabilityFrame>();

/**
 * Run `fn` inside a marked reliability scope. Any call to
 * `assertNotInReliabilityScope` made while `fn` is executing
 * (including async children that don't break the async-locals chain)
 * will throw.
 */
export async function withinReliabilityScope<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ label, enteredAt: Date.now() }, fn);
}

/**
 * Throws when called from inside any reliability scope. Used by the
 * Anthropic client wrapper to refuse AI calls on the reliability path.
 */
export function assertNotInReliabilityScope(callerLabel: string): void {
  const frame = storage.getStore();
  if (frame) {
    throw new ReliabilityPathViolation(callerLabel, frame.label);
  }
}

/** Best-effort introspection — for observability. */
export function currentReliabilityFrame(): ReliabilityFrame | undefined {
  return storage.getStore();
}

export class ReliabilityPathViolation extends Error {
  constructor(
    public readonly aiCallerLabel: string,
    public readonly reliabilityFrameLabel: string,
  ) {
    super(
      `ADR-0008 violation: AI call '${aiCallerLabel}' invoked from inside reliability scope '${reliabilityFrameLabel}'. ` +
        `AI must not sit on the reliability path.`,
    );
    this.name = 'ReliabilityPathViolation';
  }
}
