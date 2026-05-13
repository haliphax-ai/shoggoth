<template>
  <span class="a2ui-badge" :class="[variantClass, sizeClass]">
    <slot>{{ label }}</slot>
  </span>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";

export default defineComponent({
  name: "A2UIBadge",
  props: {
    def: { type: Object, required: true },
    componentId: { type: String, required: true },
    surfaceId: { type: String, default: "" },
  },
  setup(props) {
    const label = computed(() => (props.def as any).label ?? (props.def as any).text ?? "");
    const variant = computed(() => (props.def as any).variant ?? "default");
    const size = computed(() => (props.def as any).size ?? "md");

    const variantClass = computed(() => `badge-${variant.value}`);
    const sizeClass = computed(() => `badge-size-${size.value}`);

    return { label, variantClass, sizeClass };
  },
});
</script>

<style scoped>
.a2ui-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 9999px;
  font-weight: 500;
  white-space: nowrap;
}
.badge-size-sm {
  padding: 0.125rem 0.5rem;
  font-size: 0.7rem;
}
.badge-size-md {
  padding: 0.2rem 0.625rem;
  font-size: 0.75rem;
}
.badge-size-lg {
  padding: 0.25rem 0.75rem;
  font-size: 0.85rem;
}

.badge-default {
  background: var(--a2ui-muted, #e5e7eb);
  color: var(--a2ui-text, #374151);
}
.badge-primary {
  background: var(--a2ui-primary, #3b82f6);
  color: #fff;
}
.badge-success {
  background: #22c55e;
  color: #fff;
}
.badge-warning {
  background: #f59e0b;
  color: #fff;
}
.badge-error {
  background: #ef4444;
  color: #fff;
}
.badge-info {
  background: #06b6d4;
  color: #fff;
}
</style>
