// MoEViz — visual vocabulary for mixture-of-experts FFN components.
//
// MoE's structural distinctiveness from canonical FFN is *branching*: each
// token enters a router, the router scores all experts, top-k experts fire,
// and the chosen experts' outputs recombine on the way out. The viz makes
// that branching shape literal: a central router sphere on the left,
// `num_experts` expert columns fanned around the depth axis, and a
// recombination point on the right where the active experts' streamlines
// converge.
//
// `top_k` controls which experts read as "lit" (full opacity, emissive
// glow) vs "dim" (low opacity, no emissive). The eye sees which experts
// fired without needing per-token routing data — purely qualitative,
// matching the design language FeedForwardViz uses for tunnel.

import { useMemo, useRef, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

export interface MoEVizProps {
  /** Total expert count. Clamped to [2, 16] for visual sanity. */
  numExperts: number;
  /** Experts activated per token. Clamped to [1, numExperts]. */
  topK: number;
  /** Input/output dimensionality — drives router + recombiner sphere size. */
  embedDim: number;
  className?: string;
}

const PALETTE = {
  violet: new THREE.Color('#c084fc'),
  pink: new THREE.Color('#f472b6'),
  orange: new THREE.Color('#fb923c'),
  amber: new THREE.Color('#fbbf24'),
};

function endpointRadius(embedDim: number): number {
  // Same compressed mapping as FeedForwardViz.planeSize — keep router /
  // recombiner spheres legible across the embed_dim range.
  const ratio = Math.min(embedDim / 768, 8);
  return 0.35 + 0.25 * Math.pow(ratio, 0.35);
}

function ExpertColumns({ numExperts, topK }: { numExperts: number; topK: number }) {
  const n = Math.max(2, Math.min(numExperts, 16));
  const k = Math.max(1, Math.min(topK, n));

  // Experts arranged on a circle in the y-z plane (perpendicular to the
  // depth axis x). Each expert is a small bar — visually distinct from the
  // tunnel's planes so the family resemblance to FeedForwardViz reads but
  // the structural difference (parallel branches vs serial depth) is
  // unmistakable.
  const items: ReactNode[] = [];
  const radius = 2.1;
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    const y = Math.sin(angle) * radius;
    const z = Math.cos(angle) * radius;
    const isLit = i < k; // first k experts read as the "active" routing slot
    const color = isLit ? PALETTE.orange : PALETTE.violet;
    const opacity = isLit ? 0.85 : 0.18;
    const emissiveIntensity = isLit ? 0.6 : 0.0;

    items.push(
      <group key={i} position={[0, y, z]}>
        {/* Expert bar — oriented along the depth axis so it bridges
            router (left) to recombiner (right). */}
        <mesh>
          <boxGeometry args={[2.6, 0.18, 0.18]} />
          <meshStandardMaterial
            color={color}
            transparent
            opacity={opacity}
            emissive={color}
            emissiveIntensity={emissiveIntensity}
            roughness={0.4}
            metalness={0.15}
          />
        </mesh>
      </group>,
    );
  }
  return <>{items}</>;
}

function RoutingStreams({ numExperts, topK }: { numExperts: number; topK: number }) {
  const n = Math.max(2, Math.min(numExperts, 16));
  const k = Math.max(1, Math.min(topK, n));
  const radius = 2.1;

  const items: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    const y = Math.sin(angle) * radius;
    const z = Math.cos(angle) * radius;
    const isLit = i < k;
    const opacity = isLit ? 0.55 : 0.08;
    const color = isLit ? PALETTE.amber : PALETTE.violet;

    // Router → expert (left half)
    items.push(
      <Line3D
        key={`r-${i}`}
        from={[-2.6, 0, 0]}
        to={[-1.3, y, z]}
        color={color}
        opacity={opacity}
      />,
    );
    // Expert → recombiner (right half)
    items.push(
      <Line3D key={`c-${i}`} from={[1.3, y, z]} to={[2.6, 0, 0]} color={color} opacity={opacity} />,
    );
  }
  return <>{items}</>;
}

function Line3D({
  from,
  to,
  color,
  opacity,
}: {
  from: [number, number, number];
  to: [number, number, number];
  color: THREE.Color;
  opacity: number;
}) {
  // Memoize so React doesn't re-allocate the buffer geometry every frame
  // — the line endpoints are stable for the lifetime of this component.
  const geom = useMemo(
    () =>
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...from),
        new THREE.Vector3(...to),
      ]),
    [from, to],
  );
  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </lineSegments>
  );
}

function Endpoints({ embedDim }: { embedDim: number }) {
  const r = endpointRadius(embedDim);
  return (
    <>
      {/* Router sphere — pink, emissive (the "decider" gets the warm hue) */}
      <mesh position={[-2.6, 0, 0]}>
        <sphereGeometry args={[r, 20, 20]} />
        <meshStandardMaterial
          color={`#${PALETTE.pink.getHexString()}`}
          emissive={'#831843'}
          emissiveIntensity={0.45}
          roughness={0.35}
          metalness={0.15}
        />
      </mesh>
      {/* Recombiner sphere — orange, emissive (the "exit" gets the warm hue) */}
      <mesh position={[2.6, 0, 0]}>
        <sphereGeometry args={[r, 20, 20]} />
        <meshStandardMaterial
          color={`#${PALETTE.orange.getHexString()}`}
          emissive={'#7c2d12'}
          emissiveIntensity={0.45}
          roughness={0.35}
          metalness={0.15}
        />
      </mesh>
    </>
  );
}

function AutoSpin({ children }: { children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    if (ref.current) {
      ref.current.rotation.x += 0.0014;
      ref.current.rotation.y += 0.0028;
    }
  });
  return <group ref={ref}>{children}</group>;
}

export function MoEViz({ numExperts, topK, embedDim, className = '' }: MoEVizProps) {
  return (
    <div className={`relative ${className}`}>
      <Canvas
        camera={{ position: [6, 4, 8.5], fov: 50 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: 'low-power' }}
      >
        <ambientLight color={'#334155'} intensity={0.6} />
        <pointLight color={'#fbbf24'} intensity={1.3} position={[0, 8, 8]} distance={50} />
        <pointLight color={'#f472b6'} intensity={0.9} position={[-6, -4, -6]} distance={50} />

        <AutoSpin>
          <Endpoints embedDim={embedDim} />
          <ExpertColumns numExperts={numExperts} topK={topK} />
          <RoutingStreams numExperts={numExperts} topK={topK} />
        </AutoSpin>

        <OrbitControls
          enableZoom
          enablePan={false}
          minDistance={5}
          maxDistance={22}
          dampingFactor={0.08}
          rotateSpeed={0.7}
        />
      </Canvas>

      <div className="text-dim pointer-events-none absolute bottom-2 left-3 font-mono text-[10px] uppercase tracking-[0.15em]">
        {Math.min(numExperts, 16)} experts · top-{Math.min(topK, numExperts)}
      </div>
    </div>
  );
}
