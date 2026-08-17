/**
 * The feature registry, published in full.
 *
 * Every feature the model consumes, with its formula, its unit, its discretisation
 * bands and the narrative template each band maps to. This is what makes the
 * attribution auditable rather than merely presentable: a reader can trace a
 * sentence in the UI back to the threshold that produced it.
 */

import { handler, ok } from '@/lib/api/respond';
import { FEATURE_DEFINITIONS, FEATURE_GROUPS, FEATURE_GROUP_LABELS, MODEL_FEATURE_KEYS } from '@/lib/engine/features';
import { GROUP_TO_DOMAIN, INSTITUTIONAL_MAPPING_MATRIX, domainForFeature } from '@/lib/engine/narrative';

export const dynamic = 'force-static';

export const GET = handler(async () => {
  return ok({
    count: FEATURE_DEFINITIONS.length,
    modelFeatureCount: MODEL_FEATURE_KEYS.length,
    groups: FEATURE_GROUPS.map((g) => ({ key: g, label: FEATURE_GROUP_LABELS[g], domain: GROUP_TO_DOMAIN[g] })),
    features: FEATURE_DEFINITIONS.map((f) => ({
      key: f.key,
      label: f.label,
      shortLabel: f.shortLabel,
      group: f.group,
      domain: domainForFeature(f.key, f.group),
      unit: f.unit,
      description: f.description,
      formula: f.formula,
      sqlColumn: f.sqlColumn,
      aliases: f.aliases,
      inModel: f.inModel,
      states: f.states,
    })),
    mappingMatrix: Object.entries(INSTITUTIONAL_MAPPING_MATRIX).map(([key, entry]) => ({
      key,
      template: entry.template,
      semanticKey: entry.semanticKey,
    })),
  });
});
