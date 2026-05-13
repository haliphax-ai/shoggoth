<template>
  <div class="a2ui-spacer" :style="spacerStyle" aria-hidden="true" />
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";

export default defineComponent({
  name: "A2UISpacer",
  props: {
    def: { type: Object, required: true },
    componentId: { type: String, required: true },
    surfaceId: { type: String, default: "" },
  },
  setup(props) {
    const spacerStyle = computed(() => {
      const d = props.def as any;
      const size = d.size ?? d.height ?? "16px";
      const sizeStr = typeof size === "number" ? `${size}px` : size;
      return { height: sizeStr, width: "100%" };
    });

    return { spacerStyle };
  },
});
</script>

<style scoped>
.a2ui-spacer {
  flex-shrink: 0;
}
</style>
