import { useEffect, useRef, type ReactNode } from 'react';
import { motion, useMotionValue, useSpring } from 'framer-motion';

interface MagneticButtonProps {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  radius?: number;
  strength?: number;
  ariaLabel?: string;
}

/**
 * Magnetic-hover button. Within `radius` px of the cursor, the button pulls
 * toward the cursor proportionally to proximity. Spring physics on release.
 * Tactile depress on tap.
 *
 * Layer 1 (physics-driven motion) primitive per docs/Pitch_Prep_Sprint.md.
 * The strength + radius defaults are tuned to feel "alive but not aggressive"
 * — strong enough to be felt, subtle enough to not destabilize layout.
 */
export function MagneticButton({
  children,
  onClick,
  className = '',
  radius = 90,
  strength = 0.32,
  ariaLabel,
}: MagneticButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 240, damping: 18, mass: 0.4 });
  const sy = useSpring(y, { stiffness: 240, damping: 18, mass: 0.4 });

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      const cxCenter = rect.left + rect.width / 2;
      const cyCenter = rect.top + rect.height / 2;
      const dx = e.clientX - cxCenter;
      const dy = e.clientY - cyCenter;
      const dist = Math.hypot(dx, dy);
      if (dist < radius) {
        // Falls off proportionally — at radius, contribution is 0; at center, full.
        const falloff = 1 - dist / radius;
        x.set(dx * strength * falloff);
        y.set(dy * strength * falloff);
      } else {
        x.set(0);
        y.set(0);
      }
    }
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [radius, strength, x, y]);

  return (
    <motion.button
      ref={ref}
      onClick={onClick}
      aria-label={ariaLabel}
      style={{ x: sx, y: sy }}
      whileTap={{ scale: 0.97 }}
      className={className}
    >
      {children}
    </motion.button>
  );
}
