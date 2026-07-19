import { describe, it, expect } from 'vitest';
import { ML_COMPONENTS } from '../src/index.js';

// E3-3b tests: standalone activation primitives (pointwise nonlinearities).
//
// The activation category is intentionally narrow — only true pointwise
// functions (ReLU/GeLU/SiLU). SwiGLU is a gated structure and lives as
// a GatedFFN variant in E3-3c, not here. See ADR-0029.

const ACTIVATION_IDS = ['ml.relu', 'ml.gelu', 'ml.silu'] as const;

describe('activations — standalone components', () => {
  for (const id of ACTIVATION_IDS) {
    const comp = ML_COMPONENTS.find((c) => c.id === id)!;

    describe(id, () => {
      it('exists in the activation category', () => {
        expect(comp).toBeDefined();
        expect(comp.category).toBe('activation');
      });

      it('has no properties (pointwise functions have nothing to configure)', () => {
        expect(comp.properties).toHaveLength(0);
      });

      it('is single-input single-output, shape-preserving', () => {
        expect(comp.inputs).toHaveLength(1);
        expect(comp.outputs).toHaveLength(1);
        const inSig = comp.inputs[0]!.signature({});
        const outSig = comp.outputs[0]!.signature({});
        expect(inSig).toEqual(outSig);
      });

      it('PyTorch codegen emits F.<fn>(x) with no constructor', () => {
        const ir = comp.codegen({});
        const init = ir.backends.pytorch!.init('self.act');
        expect(init).toBe('');
        const fwd = ir.backends.pytorch!.forward('self.act', { in: 'x' }, { out: 'y' });
        // F.relu / F.gelu / F.silu — strip `ml.` prefix to get fn name.
        const fnName = id.slice(3);
        expect(fwd).toBe(`y = F.${fnName}(x)`);
      });
    });
  }

  it('SwiGLU is NOT in the activation category (gated, not pointwise)', () => {
    const swiglu = ML_COMPONENTS.find((c) => c.id === 'ml.swiglu');
    expect(swiglu).toBeUndefined();
  });
});
