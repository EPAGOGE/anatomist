import { describe, it, expect } from 'vitest';
import { ML_COMPONENTS } from '../src/index.js';

// E6 tests: property grouping + divisibility hints follow ADR-0033.
//
// Per ADR-0033, components with substantial property surfaces declare
// `propertyGroups`, and properties assign themselves via `group`. The
// inspector consumes these for instrument-panel rendering. These tests
// pin the conventions so future component additions follow the same
// patterns.

describe('property-grouping discipline', () => {
  it('attention variants expose position-encoding as a collapsible secondary group', () => {
    const attentionIds = [
      'ml.multi_head_attention',
      'ml.multi_query_attention',
      'ml.grouped_query_attention',
      'ml.flash_attention',
      'ml.sliding_window_attention',
    ];
    for (const id of attentionIds) {
      const spec = ML_COMPONENTS.find((c) => c.id === id)!;
      expect(spec, `${id} should exist`).toBeDefined();
      expect(spec.propertyGroups, `${id} declares propertyGroups`).toBeDefined();
      const peGroup = spec.propertyGroups!.find((g) => g.id === 'position-encoding');
      expect(peGroup, `${id} has position-encoding group`).toBeDefined();
      expect(peGroup!.defaultCollapsed).toBe(true);
      const peProp = spec.properties.find((p) => p.id === 'position_encoding');
      const ropeProp = spec.properties.find((p) => p.id === 'rope_base');
      expect(peProp?.group).toBe('position-encoding');
      expect(ropeProp?.group).toBe('position-encoding');
    }
  });

  it('CrossAttention does NOT have a position-encoding group (per ADR-0028)', () => {
    const cross = ML_COMPONENTS.find((c) => c.id === 'ml.cross_attention')!;
    // No PE properties at all on CrossAttention.
    expect(cross.properties.find((p) => p.id === 'position_encoding')).toBeUndefined();
    expect(cross.properties.find((p) => p.id === 'rope_base')).toBeUndefined();
  });

  it('MoEFFN has two distinct conceptual groups: routing + expert', () => {
    const moe = ML_COMPONENTS.find((c) => c.id === 'ml.moe_ffn')!;
    expect(moe.propertyGroups).toBeDefined();
    const groupIds = moe.propertyGroups!.map((g) => g.id).sort();
    expect(groupIds).toEqual(['expert', 'routing']);

    // routing group properties — how tokens flow to experts
    const routingProps = moe.properties.filter((p) => p.group === 'routing').map((p) => p.id);
    expect(routingProps).toContain('num_experts');
    expect(routingProps).toContain('top_k');
    expect(routingProps).toContain('capacity_factor');

    // expert group properties — what each expert looks like
    const expertProps = moe.properties.filter((p) => p.group === 'expert').map((p) => p.id);
    expect(expertProps).toContain('hidden_dim');
    expect(expertProps).toContain('activation');
    expect(expertProps).toContain('bias');

    // Neither group should be collapsed by default — both are primary work
    for (const g of moe.propertyGroups!) {
      expect(g.defaultCollapsed ?? false).toBe(false);
    }
  });

  it('every group id referenced from PropertySpec.group is declared in propertyGroups', () => {
    // Discipline check: no orphaned group ids.
    for (const spec of ML_COMPONENTS) {
      const declaredIds = new Set((spec.propertyGroups ?? []).map((g) => g.id));
      for (const prop of spec.properties) {
        if (prop.group !== undefined) {
          expect(
            declaredIds.has(prop.group),
            `${spec.id}: property ${prop.id} references group "${prop.group}" but it is not declared in propertyGroups`,
          ).toBe(true);
        }
      }
    }
  });

  it('primary properties (no group) appear first when intermixed with grouped properties', () => {
    // Convention test: components order primary props first, grouped
    // props second. The inspector relies on this so it can split the
    // list cleanly. We pin this on a representative case (MHA).
    const mha = ML_COMPONENTS.find((c) => c.id === 'ml.multi_head_attention')!;
    let sawGrouped = false;
    for (const prop of mha.properties) {
      if (prop.group !== undefined) sawGrouped = true;
      else if (sawGrouped) {
        // A primary property after a grouped property — violates convention.
        expect.fail(
          `MultiHeadAttention has primary property "${prop.id}" after a grouped property`,
        );
      }
    }
  });
});

describe('divisibility hints', () => {
  it('MHA-family attention exposes num_heads divides embed_dim', () => {
    const attentionIds = [
      'ml.multi_head_attention',
      'ml.multi_query_attention',
      'ml.grouped_query_attention',
      'ml.flash_attention',
      'ml.sliding_window_attention',
      'ml.cross_attention',
    ];
    for (const id of attentionIds) {
      const spec = ML_COMPONENTS.find((c) => c.id === id)!;
      const numHeads = spec.properties.find((p) => p.id === 'num_heads')!;
      expect(numHeads.divides, `${id} num_heads divides embed_dim`).toBe('embed_dim');
    }
  });

  it('GQA additionally exposes num_kv_heads divides num_heads', () => {
    const gqa = ML_COMPONENTS.find((c) => c.id === 'ml.grouped_query_attention')!;
    const kv = gqa.properties.find((p) => p.id === 'num_kv_heads')!;
    expect(kv.divides).toBe('num_heads');
  });

  it('most-adjusted property (num_heads) appears first in the primary group', () => {
    // Per the E6 brief: the most-common interaction should be most prominent.
    // For attention, num_heads is THE adjustment. Pin its first-place ordering.
    const attentionIds = [
      'ml.multi_head_attention',
      'ml.multi_query_attention',
      'ml.grouped_query_attention',
      'ml.flash_attention',
      'ml.sliding_window_attention',
      'ml.cross_attention',
    ];
    for (const id of attentionIds) {
      const spec = ML_COMPONENTS.find((c) => c.id === id)!;
      const firstPrimary = spec.properties.find((p) => p.group === undefined)!;
      expect(firstPrimary.id, `${id}: first primary property should be num_heads`).toBe(
        'num_heads',
      );
    }
  });
});
