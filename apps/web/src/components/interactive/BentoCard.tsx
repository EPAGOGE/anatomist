import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

interface BentoCardProps {
  children: ReactNode;
  className?: string;
  /**
   * Grid span. Drives the asymmetric bento feel — mix small/medium/wide/tall
   * cells in the same grid for the Apple-style bento layout.
   *   sm: 1×1 (default)
   *   md: 2×1 (twice as wide)
   *   wide: 3×1 (full row in a 3-col grid)
   *   tall: 1×2 (twice as tall)
   *   lg: 2×2 (the hero cell)
   */
  span?: 'sm' | 'md' | 'wide' | 'tall' | 'lg';
  interactive?: boolean;
}

const spanClass: Record<NonNullable<BentoCardProps['span']>, string> = {
  sm: 'col-span-1 row-span-1',
  md: 'col-span-1 md:col-span-2 row-span-1',
  wide: 'col-span-1 md:col-span-3 row-span-1',
  tall: 'col-span-1 row-span-1 md:row-span-2',
  lg: 'col-span-1 md:col-span-2 row-span-1 md:row-span-2',
};

/**
 * Bento-grid card. Hover scale + subtle glow on the accent.
 *
 * Use inside a `grid grid-cols-1 md:grid-cols-3` container. Mix spans for the
 * asymmetric Apple-bento feel. Cards default to interactive — pass
 * `interactive={false}` for read-only cells that shouldn't react to hover.
 */
export function BentoCard({
  children,
  className = '',
  span = 'sm',
  interactive = true,
}: BentoCardProps) {
  return (
    <motion.div
      whileHover={interactive ? { y: -3 } : undefined}
      transition={{ type: 'spring', stiffness: 280, damping: 22 }}
      className={`bg-panel border-line group relative overflow-hidden rounded-xl border p-6 transition-colors duration-300 ${
        interactive ? 'hover:border-accent/40' : ''
      } ${spanClass[span]} ${className}`}
    >
      {interactive && (
        <div
          className="from-accent/8 pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100"
          aria-hidden
        />
      )}
      <div className="relative h-full">{children}</div>
    </motion.div>
  );
}
