// Provider-agnostic compute control plane.
//
// RunPod is the first adapter; AWS / Azure become additional implementations of
// this same interface, NOT a rewrite (that is how platform gap #3, multi-cloud,
// folds in for free). The clean seam: TS owns this control plane (estimate,
// provision, watch, kill); a Python data-plane script runs ON the pod.

import type { GpuSpec } from './gpu.js';
import type { CostEstimate } from './cost.js';
import type { JobPhase, TrainingJobSpec } from './job.js';

export interface ProvisionHandle {
  providerJobId: string;
  phase: JobPhase;
}

export interface JobStatus {
  providerJobId: string;
  phase: JobPhase;
  /** Cost accrued so far, nanoUSD — fed straight into the tripwire. */
  accruedNanos: bigint;
  elapsedSeconds: number;
  logsTail?: string[];
}

export interface ComputeProvider {
  readonly id: string;

  /**
   * Available GPUs with prices. Adapters MUST fetch live prices at runtime and
   * degrade to the reference catalog when offline (marking estimates
   * `reference: true`).
   */
  listGpus(): Promise<GpuSpec[]>;

  /** Priced estimate for a spec at an assumed runtime — live price when available. */
  estimateCost(spec: TrainingJobSpec, hours: number): Promise<CostEstimate>;

  /**
   * Provision hardware and launch the data-plane job. MUST reject a spec whose
   * limits are missing or invalid — the tripwire is not optional.
   */
  provision(spec: TrainingJobSpec): Promise<ProvisionHandle>;

  /** Current status incl. accrued cost, for the heartbeat + tripwire loop. */
  status(providerJobId: string): Promise<JobStatus>;

  /** Tear down. Called on completion, failure, or a tripwire TERMINATE verdict. */
  terminate(providerJobId: string, reason: string): Promise<void>;
}
