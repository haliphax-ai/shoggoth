<template>
  <div class="a2ui-progress">
    <span v-if="resolvedLabel" class="a2ui-progress-label">{{ resolvedLabel }}</span>
    <progress class="progress progress-primary w-full" :value="clampedValue" max="100"></progress>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";
import { useDataSource, formatString } from "@shoggoth/a2ui-sdk";

export default defineComponent({
  name: "A2UIProgressBar",
  props: {
    def: { type: Object, required: true },
    surfaceId: { type: String, required: true },
    componentId: { type: String, required: true },
  },
  setup(props) {
    const { aggregatedValue, compoundAggregates, filteredRows, binding } = useDataSource(
      props as any,
    );

    function resolveTemplate(raw: unknown): string {
      const str = typeof raw === "string" ? raw : String(raw ?? "");
      if (!binding.value || !str.includes("${")) return str;
      const aggs = compoundAggregates.value;
      const allKeys: Record<string, unknown> = { ...aggs };
      if (aggregatedValue.value != null) allKeys["$value"] = aggregatedValue.value;
      const row =
        filteredRows.value && filteredRows.value.length > 0 ? filteredRows.value[0] : null;
      return formatString(str, { ...allKeys, ...(row ?? {}) });
    }

    const resolvedLabel = computed(() => resolveTemplate((props.def as any).label ?? ""));

    const clampedValue = computed(() => {
      const raw = (props.def as any).value;
      const resolved =
        binding.value && typeof raw === "string" && raw.includes("${") ? resolveTemplate(raw) : raw;
      return Math.min(100, Math.max(0, Number(resolved) || 0));
    });

    return { clampedValue, resolvedLabel };
  },
});
</script>

<style scoped>
.a2ui-progress-label {
  display: block;
  margin-bottom: 4px;
  font-size: 0.85em;
}
</style>
