import { useEffect, type ReactNode } from 'react';
import Lenis from 'lenis';

/**
 * Smooth-scroll provider. Wraps a route subtree with Lenis momentum scrolling.
 *
 * Use on landing/marketing-style surfaces (WelcomePage). Do NOT wrap the
 * Canvas surface — Rete.js has its own pan/zoom handling and Lenis will
 * fight it. Same with any virtualized list (none yet).
 *
 * Lenis hijacks the page's wheel events and animates scroll position with a
 * spring-ish ease. This is what gives modern sites their "buttery" feel.
 * Single instance per mount; teardown on unmount.
 */
export function SmoothScroll({ children }: { children: ReactNode }) {
  useEffect(() => {
    const lenis = new Lenis({
      duration: 1.15,
      // ease curve borrowed from the .sign-pulse animation in styles.css
      // (cubic-bezier(0.16, 1, 0.3, 1)) for visual cohesion
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
    });

    let rafId: number;
    function raf(time: number) {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    }
    rafId = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(rafId);
      lenis.destroy();
    };
  }, []);

  return <>{children}</>;
}
