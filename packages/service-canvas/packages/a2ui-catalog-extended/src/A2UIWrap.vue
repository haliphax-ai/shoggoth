<template>
  <div class="a2ui-wrap" :style="wrapStyle">
    <A2UINode
      v-for="childId in children"
      :key="childId"
      :component-id="childId"
      :surface-id="surfaceId"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";

export default defineComponent({
  name: "A2UIWrap",
  props: {
    def: { type: Object, required: true },
    surfaceId: { type: String, required: true },
  },
  setup(props) {
    const children = computed(() => {
      const c = (props.def as any).children;
      return c?.explicitList ?? c ?? [];
    });
    const wrapStyle = computed(() => {
      const gap = (props.def as any).gap;
      return gap ? { gap } : undefined;
    });
    return { children, wrapStyle };
  },
});
</script>

<style scoped>
.a2ui-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
