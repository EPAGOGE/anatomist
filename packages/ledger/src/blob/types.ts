// Content-addressed blob storage interface.
//
// Bytes are addressed by the lowercase-hex BLAKE3 hash of their content.
// Implementations are pluggable (local FS for dev, S3 for production); the
// same code path serves both because the interface hides the backend.
//
// Idempotence is required: put() on bytes whose hash already exists must
// succeed silently rather than fail or duplicate.

export interface BlobStore {
  /**
   * Store the given bytes. Returns the 64-char hex hash. Idempotent: if a
   * blob with that hash already exists, the call succeeds without writing.
   */
  put(bytes: Uint8Array): Promise<string>;

  /** Retrieve bytes by hash. Returns null if not stored. */
  get(hash: string): Promise<Uint8Array | null>;

  /** True iff a blob with the given hash is present. */
  has(hash: string): Promise<boolean>;

  /**
   * Delete a blob by hash. Returns true if a blob was removed; false if no
   * blob existed. Mostly used by tests; production stores should treat
   * blobs as immutable unless the chain explicitly tombstones them.
   */
  delete(hash: string): Promise<boolean>;

  /** Release any resources owned by the store. */
  close(): Promise<void>;
}
