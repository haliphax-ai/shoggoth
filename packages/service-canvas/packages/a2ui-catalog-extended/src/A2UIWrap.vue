<template>
  <div class="a2ui-wrap" :style="wrapStyle">
    <slot />
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";

export default defineComponent({
  name: "A2UIWrap",
  props: {
    def: { type: Object, required: true },
    componentId: { type: String, required: true },
    surfaceId: { type: String, default: "" },
  },
  setup(props) {
    const gap = computed(() => (props.def as any).gap ?? "8px");
    const align = computed(() => (props.def as any).align ?? "start");

    const wrapStyle = computed(() => {
      const g = typeof gap.value === "number" ? `${gap.value}px` : gap.value;
      return {
        gap: g,
        alignItems:
          align.value === "center" ? "center" : align.value === "end" ? "flex-end" : "flex-start",
      };
    });

    return { wrapStyle };
  },
});
</script>

<style scoped>
.a2ui-wrap {
  display: flex;
  flex-wrap: wrap;
  width: 100%;
}
</style>
