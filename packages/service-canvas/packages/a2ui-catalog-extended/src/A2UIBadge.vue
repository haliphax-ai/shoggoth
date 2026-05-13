<template>
  <span class="badge" :class="badgeClass">{{ displayText }}</span>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";
import { useDataSource } from "@shoggoth/a2ui-sdk";

const validVariants = ["success", "warning", "error", "info"];
const variantClassMap: Record<string, string> = {
  info: "badge-info",
  success: "badge-success",
  warning: "badge-warning",
  error: "badge-error",
};

export default defineComponent({
  name: "A2UIBadge",
  props: {
    def: { type: Object, required: true },
    surfaceId: { type: String, required: true },
    componentId: { type: String, required: true },
  },
  setup(props) {
    const { aggregatedValue, mappedProps, binding } = useDataSource(props as any);
    const displayText = computed(() => {
      if (binding.value) {
        if (mappedProps.value.text != null) return mappedProps.value.text;
        if (aggregatedValue.value != null) return aggregatedValue.value;
      }
      return (props.def as any).text ?? "";
    });
    const variant = computed(() => {
      const v = (props.def as any).variant;
      return validVariants.includes(v) ? v : "info";
    });
    const badgeClass = computed(() => variantClassMap[variant.value] ?? "badge-info");
    return { displayText, badgeClass };
  },
});
</script>
