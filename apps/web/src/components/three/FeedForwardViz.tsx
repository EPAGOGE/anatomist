// FeedForwardViz — visual vocabulary for canonical + gated FFN components.
//
// The FFN's mathematical shape is expansion-contraction: an `embed_dim`
// tensor projects up to a wider `hidden_dim` intermediate, an activation
// nonlinearity fires across that wider space, then a down-projection
// collapses back to `embed_dim`. The viz expresses that geometry literally:
// three vertical planes along the depth axis, sized to the expansion ratio,
// with opacity falling off through the hidden layer and re-igniting at the
// output. Streamlines connect each plane to the next so flow direction
// reads at a glance.
//
// Color trajectory mirrors AttentionViz — violet → pink → orange — so the
// two visualizations sit in the same palette family. The iridescent
// GRADIENT stays reserved for chain-signing per styles.css discipline;
// individual hues from its family are usable as static element colors.

import { useRef, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

export interface FeedForwardVizProps {
  /** Input/output dimensionality. Drives the size of the bookend planes. */
  embedDim: number;
  /** Intermediate dimensionality. Drives the size of the hidden plane —
   *  bigger than embedDim communicates the expansion shape. */
  hiddenDim: number;
  className?: string;
}

const PALETTE = {
  violet: new THREE.Color('#c084fc'),
  pink: new THREE.Color('#f472b6'),
  orange: new THREE.Color('#fb923c'),
};

/**
 * Map embedDim → a base plane half-width in scene units. The mapping is
 * compressed (log-ish) so a 768-dim model and a 4096-dim model both stay
 * inside a usable viewport; the visualization is qualitative, not
 * dimensionally accurate.
 */
function planeSize(dim: number, baseline = 1.6): number {
  const ratio = Math.min(dim / 768, 8);
  return baseline * Math.pow(ratio, 0.35);
}

function DepthSlices({ embedDim, hiddenDim }: { embedDim: number; hiddenDim: number }) {
  const inputSize = planeSize(embedDim);
  const hiddenSize = planeSize(hiddenDim, 1.9);
  const outputSize = planeSize(embedDim);

  const slices: Array<{
    position: [number, number, number];
    size: number;
    color: THREE.Color;
    opacity: number;
    edgeOpacity: number;
  }> = [
    // Input — solid, violet, foreground
    {
      position: [-2.2, 0, 0],
      size: inputSize,
      color: PALETTE.violet,
      opacity: 0.55,
      edgeOpacity: 0.85,
    },
    // Hidden — translucent + larger (the expansion), pink, midplane
    {
      position: [0, 0, 0],
      size: hiddenSize,
      color: PALETTE.pink,
      opacity: 0.22,
      edgeOpacity: 0.7,
    },
    // Output — solid + emissive glow, orange, background
    {
      position: [2.2, 0, 0],
      size: outputSize,
      color: PALETTE.orange,
      opacity: 0.6,
      edgeOpacity: 0.95,
    },
  ];

  const items: ReactNode[] = [];
  slices.forEach((slice, i) => {
    items.push(
      <group key={i} position={slice.position} rotation={[0, Math.PI / 2, 0]}>
        <mesh>
          <planeGeometry args={[slice.size * 2, slice.size * 2]} />
          <meshBasicMaterial
            color={slice.color}
            transparent
            opacity={slice.opacity}
            side={THREE.DoubleSide}
          />
        </mesh>
        <lineSegments>
          <edgesGeometry args={[new THREE.PlaneGeometry(slice.size * 2, slice.size * 2)]} />
          <lineBasicMaterial color={slice.color} transparent opacity={slice.edgeOpacity} />
        </lineSegments>
      </group>,
    );
  });

  return <>{items}</>;
}

function Streamlines({ embedDim, hiddenDim }: { embedDim: number; hiddenDim: number }) {
  const inputSize = planeSize(embedDim);
  const hiddenSize = planeSize(hiddenDim, 1.9);
  const outputSize = planeSize(embedDim);

  // A small set of streamlines per gap, sampled at corners + midpoints of
  // each plane. Communicates the flow direction (left-to-right) without
  // requiring per-neuron rendering — purely qualitative.
  const points: Array<{ y: number; z: number }> = [
    { y: 0.7, z: 0.7 },
    { y: -0.7, z: 0.7 },
    { y: 0.7, z: -0.7 },
    { y: -0.7, z: -0.7 },
    { y: 0, z: 0 },
  ];

  const items: ReactNode[] = [];

  points.forEach((p, i) => {
    // Input → hidden segment
    items.push(
      <Line3D
        key={`in-${i}`}
        from={[-2.2, p.y * inputSize, p.z * inputSize]}
        to={[0, p.y * hiddenSize, p.z * hiddenSize]}
        color={PALETTE.pink}
        opacity={0.25}
      />,
    );
    // Hidden → output segment
    items.push(
      <Line3D
        key={`out-${i}`}
        from={[0, p.y * hiddenSize, p.z * hiddenSize]}
        to={[2.2, p.y * outputSize, p.z * outputSize]}
        color={PALETTE.orange}
        opacity={0.35}
      />,
    );
  });

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
  const geom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(...from),
    new THREE.Vector3(...to),
  ]);
  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </lineSegments>
  );
}

function AutoSpin({ children }: { children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    if (ref.current) {
      ref.current.rotation.y += 0.0028;
    }
  });
  return <group ref={ref}>{children}</group>;
}

export function FeedForwardViz({ embedDim, hiddenDim, className = '' }: FeedForwardVizProps) {
  return (
    <div className={`relative ${className}`}>
      <Canvas
        camera={{ position: [5, 3.5, 8], fov: 50 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: 'low-power' }}
      >
        <ambientLight color={'#334155'} intensity={0.6} />
        <pointLight color={'#c084fc'} intensity={1.3} position={[-8, 6, 6]} distance={50} />
        <pointLight color={'#fb923c'} intensity={1.1} position={[8, -3, 6]} distance={50} />

        <AutoSpin>
          <DepthSlices embedDim={embedDim} hiddenDim={hiddenDim} />
          <Streamlines embedDim={embedDim} hiddenDim={hiddenDim} />
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

      <div className="text-dim pointer-events-none absolute bottom-2 left-3 font-mono text-[10px] uppercase tracking-[0.15em]">
        embed={embedDim} · hidden={hiddenDim}
      </div>
    </div>
  );
}
