<template>
  <component :is="tag" v-for="(item, idx) in items" :key="item.id ?? idx" class="a2ui-repeat-item">
    <slot :item="item" :index="idx" />
  </component>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";

export default defineComponent({
  name: "A2UIRepeat",
  props: {
    def: { type: Object, required: true },
    componentId: { type: String, required: true },
    surfaceId: { type: String, default: "" },
  },
  setup(props) {
    const items = computed(() => (props.def as any).items ?? []);
    const tag = computed(() => (props.def as any).tag ?? "div");

    return { items, tag };
  },
});
</script>
