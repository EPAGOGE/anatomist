// Training job spec + validation.
//
// The control-plane's unit of work: what to train, on what data, on which GPU,
// under which hard limits. The data plane (a Python training script running ON
// the provisioned pod) consumes this; the control plane never trains itself.

import type { GpuId } from './gpu.js';
import type { TripwireLimits } from './tripwire.js';

export type ProviderId = 'runpod' | 'aws' | 'azure' | 'local';

export interface DatasetRef {
  /** e.g. 'hf:stas/openwebtext-10k', 's3://bucket/key', 'local:/data/x'. */
  uri: string;
  /** Optional pinned revision / content hash for reproducibility. */
  revision?: string;
}

export interface TrainingJobSpec {
  name: string;
  /** Base model id (HF or local), e.g. 'gpt2', 'meta-llama/Llama-3.2-1B'. */
  baseModel: string;
  dataset: DatasetRef;
  gpu: GpuId;
  gpuCount?: number;
  /** Free-form hyperparameters handed to the data-plane training script. */
  hyperparams: Record<string, number | string | boolean>;
  /** Hard safety limits — REQUIRED. No job runs without a tripwire. */
  limits: TripwireLimits;
  provider: ProviderId;
}

export type JobPhase =
  | 'draft'
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'terminated';

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Structural validation. Returns [] when the spec is safe to provision. */
export function validateJobSpec(spec: TrainingJobSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!spec.name.trim()) issues.push({ field: 'name', message: 'name is required' });
  if (!spec.baseModel.trim()) issues.push({ field: 'baseModel', message: 'baseModel is required' });
  if (!spec.dataset.uri.trim())
    issues.push({ field: 'dataset.uri', message: 'dataset uri is required' });
  if ((spec.gpuCount ?? 1) < 1)
    issues.push({ field: 'gpuCount', message: 'gpuCount must be >= 1' });
  if (spec.limits.maxCostNanos <= 0n)
    issues.push({
      field: 'limits.maxCostNanos',
      message: 'a positive cost cap is required — no job runs without a tripwire',
    });
  if (spec.limits.maxRuntimeSeconds <= 0)
    issues.push({
      field: 'limits.maxRuntimeSeconds',
      message: 'a positive max runtime is required',
    });
  return issues;
}
