// AttentionViz — Pitch Sprint Day 7
//
// Three-dimensional visualization of a multi-head attention component.
// Heads render as translucent parallel planes (the "fan" structure);
// tokens render as spheres along the central axis. Drag-to-rotate;
// gentle auto-spin when idle.
//
// Adapted from the reference artifact `component_engine.jsx` shared
// during planning. Two changes from the reference:
//   1. Vanilla Three.js → react-three-fiber + drei (declarative,
//      React-friendly, cleaner lifecycle)
//   2. NVIDIA-green palette → Obsidian + Iridescent palette family
//      (violet → pink → orange) to maintain platform aesthetic
//      cohesion. The iridescent GRADIENT itself stays reserved for
//      chain-signing moments per the styles.css discipline; the
//      individual hues from its color family are usable as static
//      element colors (per BM pairing on atmosphere-vs-verification).
//
// Wow-moment role: when a multi-head attention node is selected on the
// canvas, this viz appears in the Visual tab of the right-aside. Params
// (heads, d_model, seq_len) update the viz live as the user edits them
// in the Inspector. This is the "the canvas node has a physical body"
// moment.

import { useRef, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

export interface AttentionVizProps {
  /** Number of attention heads. Clamped to [1, 16] for visual sanity. */
  heads: number;
  /** Model hidden dimension. Influences token-sphere scale. */
  dModel: number;
  /** Number of tokens to render along the axis. Clamped to [2, 14]. */
  seqLen: number;
  className?: string;
}

/**
 * The platform palette colors as Three.js Color instances. Indexed
 * across heads to give each plane its own hue along the iridescent
 * spectrum (violet → pink → orange).
 */
const PALETTE = {
  violet: new THREE.Color('#c084fc'),
  pink: new THREE.Color('#f472b6'),
  orange: new THREE.Color('#fb923c'),
  mint: new THREE.Color('#5eead4'),
  amber: new THREE.Color('#fbbf24'),
};

function headColorAt(index: number, count: number): THREE.Color {
  // Lerp through violet → pink → orange across the head count.
  if (count <= 1) return PALETTE.pink.clone();
  const t = index / (count - 1);
  if (t < 0.5) {
    return PALETTE.violet.clone().lerp(PALETTE.pink, t * 2);
  }
  return PALETTE.pink.clone().lerp(PALETTE.orange, (t - 0.5) * 2);
}

function HeadPlanes({ heads }: { heads: number }) {
  const spread = Math.min(Math.max(heads, 1), 16);
  const items: ReactNode[] = [];

  for (let i = 0; i < spread; i++) {
    const t = spread === 1 ? 0.5 : i / (spread - 1);
    const color = headColorAt(i, spread);
    const opacity = 0.12 + 0.08 * (1 - t);
    const x = (i - (spread - 1) / 2) * 0.42;

    items.push(
      <group key={i} position={[x, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
        <mesh>
          <planeGeometry args={[4, 4]} />
          <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} />
        </mesh>
        {/* Border outline so each head plane is visually distinct */}
        <lineSegments>
          <edgesGeometry args={[new THREE.PlaneGeometry(4, 4)]} />
          <lineBasicMaterial color={color} transparent opacity={0.55} />
        </lineSegments>
      </group>,
    );
  }

  return <>{items}</>;
}

// Token sphere colors — pulled from the same palette object used for head
// planes so the file has ONE source of truth for color literals. Pink
// is the accent token (matches --color-accent in styles.css); the deep
// rose is its emissive cousin (no exact token equivalent — picked to
// give the sphere a warm interior glow against the pink surface).
const TOKEN_COLOR = PALETTE.pink.getHexString();
const TOKEN_EMISSIVE = '#831843';

function TokenSpheres({ count, dModel }: { count: number; dModel: number }) {
  const n = Math.min(Math.max(count, 2), 14);
  const radius = 0.07 + 0.04 * Math.min(dModel / 1024, 1);
  const items: ReactNode[] = [];

  for (let j = 0; j < n; j++) {
    const y = (j - (n - 1) / 2) * 0.55;
    items.push(
      <mesh key={j} position={[0, y, 2.3]}>
        <sphereGeometry args={[radius, 16, 16]} />
        <meshStandardMaterial
          color={`#${TOKEN_COLOR}`}
          emissive={TOKEN_EMISSIVE}
          emissiveIntensity={0.3}
          roughness={0.35}
          metalness={0.15}
        />
      </mesh>,
    );
  }

  return <>{items}</>;
}

function AutoSpin({ children }: { children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);

  useFrame(() => {
    if (ref.current) {
      // Subtle rotation — slow enough that the user feels it but doesn't
      // chase the geometry with their eyes. Drag-to-rotate (via
      // OrbitControls) overrides at user discretion.
      ref.current.rotation.y += 0.0028;
    }
  });

  return <group ref={ref}>{children}</group>;
}

export function AttentionViz({ heads, dModel, seqLen, className = '' }: AttentionVizProps) {
  return (
    <div className={`relative ${className}`}>
      <Canvas
        camera={{ position: [6, 4, 9], fov: 50 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: 'low-power' }}
      >
        {/* Lighting — violet key + pink rim. Warmer than the original
            artifact's NVIDIA-green-led palette; matches the platform's
            iridescent family. */}
        <ambientLight color={'#334155'} intensity={0.6} />
        <pointLight color={'#c084fc'} intensity={1.4} position={[8, 10, 8]} distance={50} />
        <pointLight color={'#f472b6'} intensity={0.9} position={[-8, -4, -6]} distance={50} />

        <AutoSpin>
          <HeadPlanes heads={heads} />
          <TokenSpheres count={seqLen} dModel={dModel} />
        </AutoSpin>

        <OrbitControls
          enableZoom
          enablePan={false}
          minDistance={5}
          maxDistance={20}
          dampingFactor={0.08}
          rotateSpeed={0.7}
        />
      </Canvas>

      {/* HUD chip — bottom-left identifier so the user knows this is the
          visual layer of the selected component. */}
      <div className="text-dim pointer-events-none absolute bottom-2 left-3 font-mono text-[10px] uppercase tracking-[0.15em]">
        {Math.min(heads, 16)} heads · d={dModel}
      </div>
    </div>
  );
}
