<template>
  <div class="a2ui-slider">
    <span v-if="label" class="a2ui-slider-label">{{ label }}</span>
    <input type="range" class="range" :min="min" :max="max" :value="value" @input="onInput" />
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";
import { sendEvent, useFilterBind } from "@shoggoth/a2ui-sdk";

export default defineComponent({
  name: "A2UISlider",
  props: {
    def: { type: Object, required: true },
    componentId: { type: String, required: true },
    surfaceId: { type: String, default: "" },
  },
  setup(props) {
    const min = computed(() => (props.def as any).min ?? 0);
    const max = computed(() => (props.def as any).max ?? 100);
    const value = computed(() => (props.def as any).value ?? 0);
    const label = computed(() => (props.def as any).label ?? "");
    const { updateFilter, maybeEmit } = useFilterBind(props as any, {
      op: "gte",
      get nullValue() {
        return min.value;
      },
    });
    const onInput = (e: Event) => {
      const val = Number((e.target as HTMLInputElement).value);
      sendEvent("a2ui.sliderChange", { componentId: props.componentId, value: val });
      updateFilter(val);
      maybeEmit(val);
    };
    return { min, max, value, label, onInput };
  },
});
</script>

<style scoped>
.a2ui-slider {
  color: var(--a2ui-text);
}
.a2ui-slider-label {
  display: block;
  margin-bottom: 4px;
  font-size: 0.85em;
}
input[type="range"] {
  width: 100%;
  accent-color: var(--a2ui-primary);
}
</style>
