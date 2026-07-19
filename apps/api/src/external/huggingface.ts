// Hugging Face Hub client — F-0 Task 105.
//
// Browse public datasets via the HF Hub API. Routes through the
// external-API chokepoint (apps/api/src/external/http.ts) per
// BUILD_RAILS.md rail-keeper #11. Direct fetch() calls forbidden.
//
// Scope governor (build doc): "basic" — browse and reference. No
// download, no hosting. Public datasets only (no auth) by default;
// optional user-supplied HF token for higher rate limits per
// rail-keeper #16 (external credentials as user-scoped, not
// platform-wide).
//
// Future seam: a structurally identical github.ts module will
// reuse this module's shape for Task 106. The shape is deliberately
// concrete (not premature abstraction) — when the second consumer
// lands, the common shape can be extracted if it earns its place.

import { externalFetch, configureRateLimit } from './http.js';
import type { ExternalCallSiteTag } from './emission-classification.js';

const HF_BASE = 'https://huggingface.co/api';

// HF Hub's documented anonymous rate limit is generous (1000 req/5min
// for public endpoints, per their docs as of 2026). Set conservatively
// to 3 requests/second per process. Token-authenticated users get
// higher remote limits; rail-keeper #16 means we pass through the
// token but the bucket is still per-process.
configureRateLimit('huggingface', { capacity: 3, refillPerSec: 3 });

// ---- tags ----

const TAG_DATASETS_SEARCH: ExternalCallSiteTag = {
  site: 'huggingface.datasets-search',
  emission: 'read-only', // browsing is non-emitting per ADR-0039 Category 2
};

const TAG_DATASET_INFO: ExternalCallSiteTag = {
  site: 'huggingface.dataset-info',
  emission: 'read-only',
};

// ---- response types ----
// Shapes match HF Hub's documented JSON. Optional fields are common
// on HF because not every dataset declares every field.

/** Single result from /api/datasets search endpoint. */
export interface HuggingFaceDatasetSummary {
  /** Stable HF dataset identifier (e.g., "imdb", "squad", "stanfordnlp/imdb"). */
  id: string;
  /** Author / organization (parsed from id prefix when not in dedicated field). */
  author?: string;
  /** ISO-8601 last-modified timestamp. */
  lastModified?: string;
  /** Free-text tag list — task type, language, license, etc. */
  tags?: string[];
  /** Aggregate download count (HF metric). */
  downloads?: number;
  /** Like-count (HF metric). */
  likes?: number;
  /** Optional dataset card description. */
  description?: string;
}

/** Full dataset metadata from /api/datasets/:id endpoint. */
export interface HuggingFaceDatasetInfo extends HuggingFaceDatasetSummary {
  /** Card data block — additional structured metadata from the dataset card. */
  cardData?: {
    /** HF returns license as either a single SPDX string or an array of identifiers. */
    license?: string | string[];
    task_categories?: string[];
    language?: string[];
    pretty_name?: string;
    size_categories?: string[];
  };
  /** File listing on the dataset's repo. Each entry includes a path. */
  siblings?: Array<{ rfilename: string }>;
}

// ---- client surface ----

export interface SearchOptions {
  /** Search query string. */
  q: string;
  /** Max results per page (HF default: 30; max: 100). */
  limit?: number;
  /** Offset for pagination. */
  offset?: number;
  /**
   * Optional user-supplied HF token. Per rail-keeper #16: this is a
   * USER credential, never a platform secret. Caller is responsible
   * for storing it encrypted per-user and passing it in.
   */
  userToken?: string;
}

export interface InfoOptions {
  /** HF dataset id (e.g., "imdb", "squad"). */
  datasetId: string;
  userToken?: string;
}

/**
 * Search public HF datasets. Returns a page of results (HF's
 * pagination is offset-based via `limit` and `direction`/`sort`).
 * Pagination at the chokepoint (rail-keeper #12): the caller uses
 * `searchDatasets({ q, limit, offset })` and pagination cursor
 * management is consumer-driven via offset. For "give me all results"
 * cases, `searchDatasetsAll(q)` iterates internally.
 */
export async function searchDatasets(options: SearchOptions): Promise<HuggingFaceDatasetSummary[]> {
  const limit = options.limit ?? 30;
  const offset = options.offset ?? 0;
  const headers: Record<string, string> = {};
  if (options.userToken) {
    headers['Authorization'] = `Bearer ${options.userToken}`;
  }
  const result = await externalFetch<HuggingFaceDatasetSummary[]>({
    tag: TAG_DATASETS_SEARCH,
    url: `${HF_BASE}/datasets`,
    query: { search: options.q, limit, offset },
    headers,
  });
  return result.body;
}

/**
 * Fetch full info for a single HF dataset by id.
 */
export async function getDatasetInfo(options: InfoOptions): Promise<HuggingFaceDatasetInfo | null> {
  const headers: Record<string, string> = {};
  if (options.userToken) {
    headers['Authorization'] = `Bearer ${options.userToken}`;
  }
  try {
    const result = await externalFetch<HuggingFaceDatasetInfo>({
      tag: TAG_DATASET_INFO,
      url: `${HF_BASE}/datasets/${safeDatasetPath(options.datasetId)}`,
      headers,
    });
    return result.body;
  } catch (err) {
    // Any 4xx on a dataset info lookup is treated as "not browseable" —
    // 404 (doesn't exist), 401/403 (private; user-token might unlock
    // but for unauthed browsing we treat as not-found), 422 (malformed
    // id). Genuine errors (5xx, network, timeout) still throw and
    // surface as upstream-unavailable to the user.
    if (
      err !== null &&
      typeof err === 'object' &&
      'kind' in err &&
      (err as { kind?: string }).kind === 'http-4xx'
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Helpers for derived fields the chain payload needs from the HF
 * response. Kept here (not in route handler) so the route stays
 * thin and the registry-specific knowledge stays in this module.
 */
export function deriveDatasetUrl(datasetId: string): string {
  return `https://huggingface.co/datasets/${datasetId}`;
}

/**
 * HF dataset IDs can contain '/' (e.g., "stanfordnlp/imdb"). HF's API
 * expects the slash literal in the path, so blanket encodeURIComponent
 * would break routing by escaping it to %2F. Encode per-segment to
 * preserve the slash separator while still escaping other unsafe
 * characters.
 */
function safeDatasetPath(datasetId: string): string {
  return datasetId.split('/').map(encodeURIComponent).join('/');
}

export function deriveLicense(info: HuggingFaceDatasetInfo | null): string | undefined {
  const lic = info?.cardData?.license;
  if (Array.isArray(lic)) return lic[0];
  return lic;
}

export function deriveTaskType(info: HuggingFaceDatasetInfo | null): string | undefined {
  return info?.cardData?.task_categories?.[0];
}

export function deriveDatasetName(
  summary: HuggingFaceDatasetSummary,
  info: HuggingFaceDatasetInfo | null,
): string {
  return info?.cardData?.pretty_name ?? summary.id;
}
