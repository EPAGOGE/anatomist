import { useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion, useScroll, useTransform } from 'framer-motion';
import { ArrowRight, ChartLineUp, Cube, Graph, Plus, ShieldCheck } from '@phosphor-icons/react';
import { GradientMesh } from '../components/atmosphere/GradientMesh.js';
import { SmoothScroll } from '../components/atmosphere/SmoothScroll.js';
import { MagneticButton } from '../components/interactive/MagneticButton.js';
import { BentoCard } from '../components/interactive/BentoCard.js';
import { listChains, listProjects } from '../api/endpoints.js';

/**
 * WelcomePage — the new landing surface for the platform.
 *
 * Composes all four interactive layers (per docs/Pitch_Prep_Sprint.md):
 *  - Layer 1 physics-driven motion: MagneticButton on CTAs, BentoCard hover-springs
 *  - Layer 2 generative atmosphere: GradientMesh shader background
 *  - Layer 3 live data streams: bento stats poll every 5s for chain events,
 *    projects, AI cost (Layer 3 frontend-polling implementation; SSE
 *    chain-stream lands in Day 5 for the chain ribbon)
 *  - Layer 4 spatial substrate: GradientMesh uses react-three-fiber, the
 *    same r3f setup the Day 7-8 3D MHA preview will mount into
 *  - Plus scroll-driven hero fade (Framer Motion useScroll + useTransform)
 *  - Plus Lenis smooth scroll (mounted via SmoothScroll wrapper)
 *
 * The hero's "cryptographic provenance" phrase uses text-accent (static
 * fuchsia), NOT text-iridescent — the iridescent gradient is reserved for
 * actual chain-signing moments (Day 5 chain-ribbon work, per styles.css
 * discipline). Scarcity is the point.
 */
export function WelcomePage() {
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref });

  // Hero subtle fade-and-shrink as the user scrolls into the bento section
  const heroOpacity = useTransform(scrollYProgress, [0, 0.35], [1, 0]);
  const heroScale = useTransform(scrollYProgress, [0, 0.35], [1, 0.96]);
  const heroY = useTransform(scrollYProgress, [0, 0.35], [0, -32]);

  // Live data — Layer 3, polling every 5s
  const chains = useQuery({
    queryKey: ['chains'],
    queryFn: listChains,
    refetchInterval: 5000,
  });
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
    refetchInterval: 5000,
  });
  // Total events across all readable chains — sum the bigint-as-string counts
  const totalEvents =
    chains.data?.chains?.reduce((acc, c) => acc + Number(c.event_count ?? '0'), 0) ?? null;

  return (
    <SmoothScroll>
      <div ref={ref} className="relative min-h-[200vh]">
        {/* Layer 2: atmospheric gradient mesh — fixed behind everything */}
        <GradientMesh className="fixed" />

        {/* HERO */}
        <motion.section
          style={{ opacity: heroOpacity, scale: heroScale, y: heroY }}
          className="relative flex min-h-[78vh] flex-col items-center justify-center px-6 text-center"
        >
          {/* Product wordmark — Rubik Puddles via the `wordmark` class (styles.css). */}
          <div className="wordmark text-text mb-8 text-6xl md:text-7xl">Anatomist</div>
          <h1 className="text-text mb-6 max-w-3xl text-5xl font-bold leading-[1.05] tracking-tight md:text-6xl">
            Compose AI architectures
            <br />
            with <span className="text-accent">cryptographic provenance</span>
          </h1>
          <p className="text-dim mb-10 max-w-xl text-base leading-relaxed">
            Every component, every connection, every change: signed, chained, and verifiable. Visual
            composition meets cryptographic truth.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <MagneticButton
              ariaLabel="Open the canvas"
              onClick={() => navigate('/canvas')}
              className="bg-accent shadow-accent/25 inline-flex items-center gap-2 rounded-lg px-7 py-3 font-medium text-black shadow-lg"
            >
              <Cube weight="bold" size={18} />
              Open the canvas
              <ArrowRight weight="bold" size={16} />
            </MagneticButton>
            <MagneticButton
              ariaLabel="Browse chains"
              onClick={() => navigate('/chains-list')}
              className="border-line text-text hover:border-accent/50 inline-flex items-center gap-2 rounded-lg border px-7 py-3 font-medium transition-colors"
            >
              <Graph weight="regular" size={18} />
              Browse chains
            </MagneticButton>
          </div>

          {/* Subtle scroll-affordance hint */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.4, duration: 0.8 }}
            className="text-dim absolute bottom-8 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-[0.25em]"
          >
            scroll
          </motion.div>
        </motion.section>

        {/* LIVE STATE — Layer 3 data */}
        <section className="relative px-6 py-20">
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-120px' }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="mx-auto max-w-6xl"
          >
            <div className="mb-8 flex items-end justify-between">
              <div>
                <div className="text-dim mb-2 text-xs uppercase tracking-[0.22em]">
                  Your workspace
                </div>
                <h2 className="text-text text-3xl font-bold tracking-tight">Live state</h2>
              </div>
              <div className="text-dim flex items-center gap-2 text-xs"> polling every 5s</div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:grid-rows-2">
              {/* Chain events — hero cell */}
              <BentoCard span="lg">
                <div className="flex h-full flex-col justify-between">
                  <div>
                    <div className="mb-3 flex items-center gap-2">
                      <ShieldCheck weight="duotone" size={22} className="text-success" />
                      <span className="text-dim text-xs uppercase tracking-[0.18em]">
                        Chain events signed
                      </span>
                    </div>
                    <div className="text-text font-mono text-6xl font-bold tabular-nums">
                      {totalEvents != null ? totalEvents.toLocaleString() : '-'}
                    </div>
                  </div>
                  <div className="text-dim mt-6 text-xs leading-relaxed">
                    Ed25519 + ML-DSA-65 hybrid signatures.
                    <br />
                    Append-only chains, per-event provenance.
                  </div>
                </div>
              </BentoCard>

              {/* Projects — tall so it fills col 3 across both rows (was paired
                  with the removed cost tile). */}
              <BentoCard span="tall">
                <div className="mb-3 flex items-center gap-2">
                  <Cube weight="duotone" size={18} className="text-accent" />
                  <span className="text-dim text-xs uppercase tracking-[0.18em]">Projects</span>
                </div>
                <div className="text-text font-mono text-3xl font-bold tabular-nums">
                  {projects.data?.projects?.length ?? '-'}
                </div>
              </BentoCard>

              {/* Verifiable provenance — wide */}
              <BentoCard span="wide">
                <div className="flex items-center justify-between gap-6">
                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <ChartLineUp weight="duotone" size={20} className="text-success" />
                      <span className="text-dim text-xs uppercase tracking-[0.18em]">
                        Verifiable provenance
                      </span>
                    </div>
                    <div className="text-text text-sm leading-relaxed">
                      Every event signed. Every chain forward-only. Every export carries its origin
                      hash.
                    </div>
                  </div>
                  <Link
                    to="/chains-list"
                    className="text-accent hover:text-accent-soft flex shrink-0 items-center gap-1 text-sm whitespace-nowrap transition-colors"
                  >
                    Explore <ArrowRight size={14} />
                  </Link>
                </div>
              </BentoCard>
            </div>
          </motion.div>
        </section>

        {/* PICK A THREAD — secondary CTAs */}
        <section className="relative px-6 py-24">
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-120px' }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="mx-auto max-w-5xl text-center"
          >
            <h2 className="text-text mb-3 text-3xl font-bold tracking-tight">Pick a thread</h2>
            <p className="text-dim mx-auto mb-12 max-w-md text-sm">
              Start where it makes sense. The chain captures the rest.
            </p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Link to="/canvas" className="block">
                <BentoCard className="text-left">
                  <Cube weight="duotone" size={28} className="text-accent mb-3" />
                  <div className="text-text mb-1 font-medium">Compose</div>
                  <div className="text-dim text-xs leading-relaxed">
                    Drag components onto the canvas. Watch PyTorch update live.
                  </div>
                </BentoCard>
              </Link>
              <Link to="/projects" className="block">
                <BentoCard className="text-left">
                  <Plus weight="duotone" size={28} className="text-accent-soft mb-3" />
                  <div className="text-text mb-1 font-medium">Start a project</div>
                  <div className="text-dim text-xs leading-relaxed">
                    Scope a workspace. Every step joins the chain.
                  </div>
                </BentoCard>
              </Link>
              <Link to="/chains-list" className="block">
                <BentoCard className="text-left">
                  <Graph weight="duotone" size={28} className="text-success mb-3" />
                  <div className="text-text mb-1 font-medium">Browse chains</div>
                  <div className="text-dim text-xs leading-relaxed">
                    See every signed event, every reasoning capture.
                  </div>
                </BentoCard>
              </Link>
            </div>
          </motion.div>
        </section>
      </div>
    </SmoothScroll>
  );
}
