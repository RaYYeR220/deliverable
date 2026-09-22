'use client';

import { useEffect } from 'react';

/**
 * The cursor is the lamp. Its position relative to the centre of the viewport gives the
 * light vector, signed on both axes, so crossing the centre moves the source to the other
 * side and the shaded and lit walls change places. The vector's length is held inside a
 * raking band: never so short that the stone is lit flat, never longer than the corner.
 *
 * Under prefers-reduced-motion nothing moves: the stone keeps the fixed raking light from
 * the upper left that :root declares.
 */
const MIN = 0.62;
const MAX = 1.42;

export function LightSource() {
  useEffect(() => {
    const root = document.documentElement;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let tx = 1;
    let ty = 1;
    let lx = 1;
    let ly = 1;
    let frame = 0;

    const step = () => {
      lx += (tx - lx) * 0.18;
      ly += (ty - ly) * 0.18;
      root.style.setProperty('--lx', lx.toFixed(3));
      root.style.setProperty('--ly', ly.toFixed(3));
      frame = Math.abs(tx - lx) > 0.002 || Math.abs(ty - ly) > 0.002 ? requestAnimationFrame(step) : 0;
    };

    const track = (x: number, y: number) => {
      const w = Math.max(1, window.innerWidth);
      const h = Math.max(1, window.innerHeight);
      let vx = 1 - 2 * (x / w);
      let vy = 1 - 2 * (y / h);
      let m = Math.sqrt(vx * vx + vy * vy);
      if (m < 1e-3) {
        vx = vy = MIN / Math.SQRT2;
        m = MIN;
      }
      const k = Math.min(MAX, Math.max(MIN, m)) / m;
      tx = vx * k;
      ty = vy * k;
      if (!frame) frame = requestAnimationFrame(step);
    };

    const onMouse = (e: MouseEvent) => track(e.clientX, e.clientY);
    const onTouch = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) track(t.clientX, t.clientY);
    };

    const attach = () => {
      window.addEventListener('mousemove', onMouse, { passive: true });
      window.addEventListener('touchmove', onTouch, { passive: true });
    };
    const detach = () => {
      window.removeEventListener('mousemove', onMouse);
      window.removeEventListener('touchmove', onTouch);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      tx = ty = lx = ly = 1;
      root.style.removeProperty('--lx');
      root.style.removeProperty('--ly');
    };

    const onPreference = () => (reduce.matches ? detach() : attach());
    if (!reduce.matches) attach();
    reduce.addEventListener('change', onPreference);
    return () => {
      reduce.removeEventListener('change', onPreference);
      detach();
    };
  }, []);

  return null;
}
