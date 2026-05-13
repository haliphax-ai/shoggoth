<template>
  <div class="a2ui-stack" :class="[directionClass, alignClass, justifyClass]" :style="gapStyle">
    <slot />
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";

export default defineComponent({
  name: "A2UIStack",
  props: {
    def: { type: Object, required: true },
    componentId: { type: String, required: true },
    surfaceId: { type: String, default: "" },
  },
  setup(props) {
    const direction = computed(() => (props.def as any).direction ?? "vertical");
    const align = computed(() => (props.def as any).align ?? "stretch");
    const justify = computed(() => (props.def as any).justify ?? "start");
    const gap = computed(() => (props.def as any).gap ?? "8px");

    const directionClass = computed(() =>
      direction.value === "horizontal" ? "stack-h" : "stack-v",
    );
    const alignClass = computed(() => `stack-align-${align.value}`);
    const justifyClass = computed(() => `stack-justify-${justify.value}`);
    const gapStyle = computed(() => {
      const g = typeof gap.value === "number" ? `${gap.value}px` : gap.value;
      return { gap: g };
    });

    return { directionClass, alignClass, justifyClass, gapStyle };
  },
});
</script>

<style scoped>
.a2ui-stack {
  display: flex;
  width: 100%;
}
.stack-v {
  flex-direction: column;
}
.stack-h {
  flex-direction: row;
}

.stack-align-start {
  align-items: flex-start;
}
.stack-align-center {
  align-items: center;
}
.stack-align-end {
  align-items: flex-end;
}
.stack-align-stretch {
  align-items: stretch;
}

.stack-justify-start {
  justify-content: flex-start;
}
.stack-justify-center {
  justify-content: center;
}
.stack-justify-end {
  justify-content: flex-end;
}
.stack-justify-between {
  justify-content: space-between;
}
.stack-justify-around {
  justify-content: space-around;
}
</style>
