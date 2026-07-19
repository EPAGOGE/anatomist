// GitHub API client — F-0 Task 106 (basic code export, PAT-first).
//
// Routes through the external-API chokepoint (apps/api/src/external/http.ts)
// per BUILD_RAILS.md rail-keeper #11. Direct fetch() calls forbidden —
// rail-guard #21 (ESLint) machine-enforces this from outside this file.
//
// Scope governor (build doc + slow-roll): "basic" — one-directional
// code export, explicit per-export user action. NO long-lived
// platform-side storage of credentials. The user provides a Personal
// Access Token (PAT) per export request; the platform uses it and
// discards it (rail-keeper #16: external credentials as user-scoped,
// not platform-wide). OAuth is deferred — see ADR-0041 for the
// rationale on PAT-first slow-roll.
//
// Today's only consumer: code-exports routes (Task 106). Future
// consumers: any other GitHub-related integration. The client surface
// is intentionally small (repo metadata read + file write) to match
// what Task 106's basic export needs.

import { externalFetch, configureRateLimit } from './http.js';
import type { ExternalCallSiteTag } from './emission-classification.js';

const GH_BASE = 'https://api.github.com';

// GitHub authenticated PAT users get 5000 req/hour (= ~83/min = ~1.4/s).
// Set a conservative 1 req/s bucket per process, leaving headroom for
// retry on transient failures without tripping the remote rate limit.
configureRateLimit('github', { capacity: 5, refillPerSec: 1 });

// ---- tags ----

const TAG_REPO_GET: ExternalCallSiteTag = {
  site: 'github.repo-get',
  emission: 'read-only',
};

const TAG_CONTENTS_GET: ExternalCallSiteTag = {
  site: 'github.contents-get',
  emission: 'read-only',
};

const TAG_CONTENTS_PUT: ExternalCallSiteTag = {
  site: 'github.contents-put',
  emission: 'state-change-on-target',
};

// ---- response types ----

/** Minimal GitHub repo metadata used for pre-flight validation. */
export interface GitHubRepoInfo {
  /** "owner/repo" form. */
  full_name: string;
  /** Default branch name (e.g., "main", "master"). */
  default_branch: string;
  /** Whether the authenticated PAT can write to this repo. */
  permissions?: {
    push?: boolean;
    admin?: boolean;
  };
  /** Whether the repo is private — affects PAT scope requirements. */
  private: boolean;
}

/** GitHub's contents-API response for a single file. */
export interface GitHubContentFile {
  /** File path within the repo. */
  path: string;
  /** SHA of the file blob (used as the `sha` argument on PUT updates). */
  sha: string;
  /** Base64-encoded file content. */
  content?: string;
  encoding?: string;
}

/** Response from PUT /repos/{owner}/{repo}/contents/{path}. */
export interface GitHubContentsPutResponse {
  content: {
    name: string;
    path: string;
    sha: string;
  };
  commit: {
    sha: string;
    html_url: string;
    message: string;
  };
}

// ---- client surface ----

export interface GitHubAuthOptions {
  /**
   * GitHub Personal Access Token. Per rail-keeper #16: this is a USER
   * credential, never a platform secret. The caller passes it in per
   * request; the platform NEVER persists it.
   */
  userToken: string;
}

export interface GetRepoOptions extends GitHubAuthOptions {
  owner: string;
  repo: string;
}

export interface PutContentsOptions extends GitHubAuthOptions {
  owner: string;
  repo: string;
  /** File path inside the repo (e.g., "src/model.py"). */
  path: string;
  /** Plaintext content; the function base64-encodes it. */
  content: string;
  /** Commit message. */
  message: string;
  /** Target branch. */
  branch: string;
  /**
   * Required when updating an existing file; pass undefined when
   * creating. GitHub's API requires the prior blob SHA as a
   * precondition on update; this prevents lost-update races.
   */
  sha?: string;
}

/**
 * Fetch metadata for a single repo. Used as pre-flight validation
 * before attempting a write: confirms the repo exists, the PAT can
 * see it, and (if `permissions.push` is present) the PAT has write
 * access. Returns null on 404; throws on other 4xx/5xx via the
 * normalized ExternalFetchError.
 */
export async function getRepo(options: GetRepoOptions): Promise<GitHubRepoInfo | null> {
  try {
    const result = await externalFetch<GitHubRepoInfo>({
      tag: TAG_REPO_GET,
      url: `${GH_BASE}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`,
      headers: githubAuthHeaders(options.userToken),
    });
    return result.body;
  } catch (err) {
    if (
      err !== null &&
      typeof err === 'object' &&
      'kind' in err &&
      (err as { kind?: string }).kind === 'http-4xx' &&
      'status' in err &&
      (err as { status?: number }).status === 404
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Get the blob SHA for a file at a path on a specific branch. Returns
 * null if the file doesn't exist (404). Used as a pre-step before
 * putContents() to decide create-vs-update.
 */
export async function getContentsFileSha(options: {
  owner: string;
  repo: string;
  path: string;
  branch: string;
  userToken: string;
}): Promise<string | null> {
  try {
    const result = await externalFetch<GitHubContentFile | GitHubContentFile[]>({
      tag: TAG_CONTENTS_GET,
      url: `${GH_BASE}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/contents/${encodePath(options.path)}`,
      query: { ref: options.branch },
      headers: githubAuthHeaders(options.userToken),
    });
    // Directory listings return an array; a file path returns a single object.
    if (Array.isArray(result.body)) return null;
    return result.body.sha;
  } catch (err) {
    if (
      err !== null &&
      typeof err === 'object' &&
      'kind' in err &&
      (err as { kind?: string }).kind === 'http-4xx' &&
      'status' in err &&
      (err as { status?: number }).status === 404
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Create or update a file in a GitHub repo via the contents API. This
 * is the only state-changing call in the GitHub client surface. Returns
 * the resulting commit SHA and HTML URL.
 *
 * Per rail-keeper #15 (emission-classification): this is tagged
 * 'state-change-on-target' — the GitHub repo's state changes. The
 * platform's chain emission for the export happens at the route layer
 * AFTER this call returns successfully (we need the commit SHA from
 * the response to put IN the chain event).
 */
export async function putContents(options: PutContentsOptions): Promise<GitHubContentsPutResponse> {
  const body: Record<string, unknown> = {
    message: options.message,
    content: Buffer.from(options.content, 'utf8').toString('base64'),
    branch: options.branch,
  };
  if (options.sha !== undefined) {
    body.sha = options.sha;
  }
  const result = await externalFetch<GitHubContentsPutResponse>({
    tag: TAG_CONTENTS_PUT,
    method: 'PUT',
    url: `${GH_BASE}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/contents/${encodePath(options.path)}`,
    headers: githubAuthHeaders(options.userToken),
    body,
  });
  return result.body;
}

// ---- helpers ----

function githubAuthHeaders(userToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${userToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/**
 * Encode a repo file path for the GitHub contents API. Like dataset
 * IDs on HF Hub (Task 105), GitHub paths use `/` as separator and
 * must NOT be wholesale URL-encoded — only the individual segments.
 * (Same lesson applied here as in the Task 105 huggingface.ts
 * safeDatasetPath function: per-segment encoding preserves the
 * slash separator.)
 */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
