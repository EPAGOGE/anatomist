import pg from 'pg';
import { attestation } from '@epagoge/crypto';
import { signEvent, createPostgresLedger, type PublicKeyResolver } from '@epagoge/ledger';
import { makeCheck } from '../runner.js';
import type { Check } from '../types.js';

/**
 * Live end-to-end ledger check. Uses an isolated chain_id and source_id so it
 * leaves no permanent state in shared chains.
 */
export function ledgerEndToEndCheck(databaseUrl: string): Check {
  return makeCheck('ledger-end-to-end', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    const ledger = createPostgresLedger({ pool });

    try {
      const keys = await attestation.generateKeyPair();
      const sourceId = `doctor-${Math.random().toString(36).slice(2, 10)}`;
      const chainId = `doctor-${Math.random().toString(36).slice(2, 10)}`;

      const resolver: PublicKeyResolver = async () => ({
        pq: keys.mldsa.publicKey,
        classical: keys.ed25519.publicKey,
      });

      const validHash = (n: number) => n.toString(16).padStart(64, '0');

      const evt = await signEvent(
        {
          version: 1,
          chain_id: chainId,
          event_type: 'system-operational',
          source_id: sourceId,
          causal_predecessors: [],
          absence_set_delta: [],
          source_reliability: 65535,
          causal_sequence_marker: 1n,
          ground_truth_calibration_indicator: undefined,
          payload_integrity: validHash(1),
        },
        { pq: keys.mldsa, classical: keys.ed25519 },
      );

      const hash = await ledger.appendEvent(evt, resolver);

      const fetched = await ledger.getEvent(hash);
      if (!fetched) throw new Error('getEvent returned null for just-appended event');
      if (fetched.causal_sequence_marker !== 1n) {
        throw new Error('round-tripped marker mismatch');
      }

      const verification = await ledger.verifyChain(chainId, resolver, { sourceId });
      if (!verification.ok) {
        throw new Error(
          `verifyChain reported failures: ${verification.failures
            .map((f) => `${f.reason}@${f.eventHash}`)
            .join(', ')}`,
        );
      }

      // Cleanup: remove the throwaway chain to keep the DB clean.
      await pool.query('delete from event_predecessors where event_hash = $1', [hash]);
      await pool.query('delete from event_absence_entries where event_hash = $1', [hash]);
      await pool.query('delete from events where event_hash = $1', [hash]);
      await pool.query('delete from chain_heads where chain_id = $1 and source_id = $2', [
        chainId,
        sourceId,
      ]);

      return `appended, fetched, verified, cleaned up`;
    } finally {
      await ledger.close();
    }
  });
}
