export function buildConfigSyncResponse(values: {
  generation?: number | null;
  appliedConfigIds: string[];
  removedConfigIds: string[];
}) {
  return {
    ok: true,
    appliedConfigIds: values.appliedConfigIds,
    removedConfigIds: values.removedConfigIds,
    skippedConfigIds: [],
    generation: values.generation ?? null,
  };
}
