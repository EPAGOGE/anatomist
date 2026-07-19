import { Canvas, useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';

/**
 * Atmospheric gradient-mesh shader background.
 *
 * Slowly-drifting WebGL noise field tinted in the iridescent palette family
 * (violet → pink → orange). Sits at ~8% intensity — sets tone, never competes
 * with foreground work. This is Layer 2 of the four interactive layers
 * (generative atmosphere) per docs/Pitch_Prep_Sprint.md.
 *
 * Honest distinction from the iridescent discipline: this shader uses the
 * SAME color family as the iridescent gradient but at very low intensity for
 * ambient tone. The .text-iridescent / .bg-iridescent / .sign-pulse utilities
 * remain reserved for the high-intensity signing-moment treatment per the
 * styles.css discipline. Atmosphere ≠ verification-moment.
 */

const fragmentShader = `
  uniform float uTime;
  varying vec2 vUv;

  // Compact 2D simplex noise — Ashima/Stefan Gustavson, public domain.
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  void main() {
    vec2 st = vUv;
    float t = uTime * 0.025;

    // Two layered noise octaves for organic drift
    float n1 = snoise(st * 2.2 + vec2(t, t * 0.6));
    float n2 = snoise(st * 4.5 - vec2(t * 0.4, t * 0.25));
    float n = (n1 + n2 * 0.5) * 0.5 + 0.5;

    // Palette family — same hex as the iridescent gradient
    vec3 violet = vec3(0.753, 0.518, 0.988);  // #c084fc
    vec3 pink   = vec3(0.957, 0.447, 0.714);  // #f472b6
    vec3 orange = vec3(0.984, 0.573, 0.235);  // #fb923c

    // Three-way mix driven by noise
    vec3 col = mix(violet, pink, smoothstep(0.2, 0.6, n));
    col = mix(col, orange, smoothstep(0.55, 0.95, n));

    // Atmospheric — caps at 8% intensity so the foreground always wins
    float intensity = 0.08 * smoothstep(0.0, 1.0, n);

    gl_FragColor = vec4(col, intensity);
  }
`;

const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

function AnimatedPlane() {
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  useFrame(({ clock }) => {
    const uniforms = materialRef.current?.uniforms;
    if (uniforms?.uTime) {
      uniforms.uTime.value = clock.elapsedTime;
    }
  });

  return (
    <mesh>
      <planeGeometry args={[4, 4]} />
      <shaderMaterial
        ref={materialRef}
        fragmentShader={fragmentShader}
        vertexShader={vertexShader}
        transparent
        uniforms={{ uTime: { value: 0 } }}
      />
    </mesh>
  );
}

export function GradientMesh({ className = '' }: { className?: string }) {
  return (
    <div className={`pointer-events-none absolute inset-0 -z-10 ${className}`} aria-hidden>
      <Canvas
        camera={{ position: [0, 0, 1], fov: 50 }}
        dpr={[1, 1.5]}
        gl={{ alpha: true, antialias: true, powerPreference: 'low-power' }}
      >
        <AnimatedPlane />
      </Canvas>
    </div>
  );
}
