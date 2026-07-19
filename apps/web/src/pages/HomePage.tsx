import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getBudget, listChains, type ChainSummary } from '../api/endpoints.js';
import { formatCount, formatNanosAsUsd, shortChainId, truncateHash } from '../util/format.js';

export function HomePage() {
  const chainsQuery = useQuery({ queryKey: ['chains'], queryFn: listChains });
  const budgetQuery = useQuery({
    queryKey: ['ai-budget'],
    queryFn: getBudget,
    // Budget is fine to be slightly stale.
    staleTime: 30_000,
  });

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <BudgetCard
          loading={budgetQuery.isLoading}
          error={budgetQuery.error}
          data={budgetQuery.data}
        />
      </div>

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Chains</h2>
          {chainsQuery.data && (
            <span className="text-xs text-neutral-500">
              {chainsQuery.data.chains.length} readable
            </span>
          )}
        </div>

        {chainsQuery.isLoading && <Skeleton rows={3} />}
        {chainsQuery.error && (
          <ErrorBox message={(chainsQuery.error as Error).message ?? 'failed to load chains'} />
        )}
        {chainsQuery.data && (
          <ul className="divide-y divide-neutral-800 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/30">
            {chainsQuery.data.chains.map((chain) => (
              <ChainRow key={chain.chain_id} chain={chain} />
            ))}
            {chainsQuery.data.chains.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-neutral-500">
                No readable chains yet.
              </li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

function ChainRow({ chain }: { chain: ChainSummary }) {
  return (
    <li>
      <Link
        to={`/chains/${encodeURIComponent(chain.chain_id)}`}
        className="flex items-center gap-4 px-4 py-3 transition hover:bg-neutral-900/60"
      >
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm font-medium text-neutral-100">
            {shortChainId(chain.chain_id)}
          </div>
          <div className="mt-0.5 text-xs text-neutral-500">
            owner: {chain.owner_type} ·{' '}
            <span className="text-neutral-400">{truncateHash(chain.owner_entity_id)}</span>
          </div>
        </div>
        <div className="text-right text-xs text-neutral-400">
          <div>
            <span className="font-medium text-neutral-100">{formatCount(chain.event_count)}</span>{' '}
            events
          </div>
          {chain.head_hash && (
            <div className="mt-0.5 font-mono text-neutral-600" title={chain.head_hash}>
              head {truncateHash(chain.head_hash)}
            </div>
          )}
        </div>
      </Link>
    </li>
  );
}

function BudgetCard({
  loading,
  error,
  data,
}: {
  loading: boolean;
  error: unknown;
  data: import('../api/endpoints.js').BudgetResponse | undefined;
}) {
  if (loading) {
    return (
      <Card title="Monthly budget">
        <Skeleton rows={2} />
      </Card>
    );
  }
  if (error) {
    return (
      <Card title="Monthly budget">
        <ErrorBox message={(error as Error).message ?? 'failed to load budget'} />
      </Card>
    );
  }
  if (!data) return null;

  // The API returns raw amounts; the derived percentage and warn state
  // are computed client-side. Using BigInt math then converting to a
  // float for display avoids precision loss on the dollar amounts.
  const cap = BigInt(data.cap_nanos);
  const spent = BigInt(data.spent_nanos);
  const pct = cap === 0n ? 0 : Math.min(100, Number((spent * 10000n) / cap) / 100);
  const warnTriggered = pct >= data.warn_at_pct;
  const barColor = pct >= 95 ? 'bg-red-500' : warnTriggered ? 'bg-amber-400' : 'bg-emerald-500';

  return (
    <Card title="Monthly budget">
      <div className="text-xl font-semibold text-neutral-100">
        {formatNanosAsUsd(data.spent_nanos)}{' '}
        <span className="text-sm font-normal text-neutral-500">
          / {formatNanosAsUsd(data.cap_nanos, 2)}
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-neutral-800">
        <div className={`h-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-xs text-neutral-500">
        <span>{pct.toFixed(1)}% used</span>
        <span>warns at {data.warn_at_pct}%</span>
      </div>
    </Card>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
      <div className="mb-2 text-xs uppercase tracking-wide text-neutral-500">{title}</div>
      {children}
    </div>
  );
}

function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-neutral-800" />
      ))}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
      {message}
    </div>
  );
}
