<template>
  <div
    class="a2ui-progress-bar"
    role="progressbar"
    :aria-valuenow="value"
    :aria-valuemin="min"
    :aria-valuemax="max"
  >
    <div class="a2ui-progress-track">
      <div class="a2ui-progress-fill" :class="variantClass" :style="{ width: percentage + '%' }" />
    </div>
    <span v-if="showLabel" class="a2ui-progress-label">{{ labelText }}</span>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";

export default defineComponent({
  name: "A2UIProgressBar",
  props: {
    def: { type: Object, required: true },
    componentId: { type: String, required: true },
    surfaceId: { type: String, default: "" },
  },
  setup(props) {
    const value = computed(() => (props.def as any).value ?? 0);
    const min = computed(() => (props.def as any).min ?? 0);
    const max = computed(() => (props.def as any).max ?? 100);
    const variant = computed(() => (props.def as any).variant ?? "primary");
    const showLabel = computed(() => (props.def as any).showLabel ?? false);

    const percentage = computed(() => {
      const range = max.value - min.value;
      if (range <= 0) return 0;
      return Math.min(100, Math.max(0, ((value.value - min.value) / range) * 100));
    });

    const labelText = computed(() => {
      if ((props.def as any).label) return (props.def as any).label;
      return `${Math.round(percentage.value)}%`;
    });

    const variantClass = computed(() => `progress-${variant.value}`);

    return { value, min, max, percentage, showLabel, labelText, variantClass };
  },
});
</script>

<style scoped>
.a2ui-progress-bar {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.a2ui-progress-track {
  width: 100%;
  height: 8px;
  background: var(--a2ui-muted, #e5e7eb);
  border-radius: 9999px;
  overflow: hidden;
}
.a2ui-progress-fill {
  height: 100%;
  border-radius: 9999px;
  transition: width 0.3s ease;
}
.progress-primary {
  background: var(--a2ui-primary, #3b82f6);
}
.progress-success {
  background: #22c55e;
}
.progress-warning {
  background: #f59e0b;
}
.progress-error {
  background: #ef4444;
}
.progress-info {
  background: #06b6d4;
}
.a2ui-progress-label {
  font-size: 0.75rem;
  color: var(--a2ui-text-muted, #6b7280);
}
</style>
