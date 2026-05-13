<template>
  <label class="a2ui-datetime-input form-control w-full">
    <span v-if="label" class="label-text">{{ label }}</span>
    <input
      class="input input-bordered w-full"
      :type="inputType"
      :value="value"
      :min="min || undefined"
      :max="max || undefined"
      @input="onInput"
    />
  </label>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";
import { sendEvent, useFilterBind } from "@shoggoth/a2ui-sdk";

export default defineComponent({
  name: "A2UIDateTimeInput",
  props: {
    def: { type: Object, required: true },
    surfaceId: { type: String, required: true },
    componentId: { type: String, required: true },
  },
  setup(props) {
    const label = computed(() => {
      const l = (props.def as any).label;
      return l?.literalString ?? l ?? "";
    });
    const value = computed(() => {
      const v = (props.def as any).value;
      return v?.literalString ?? v ?? "";
    });
    const enableDate = computed(() => (props.def as any).enableDate ?? false);
    const enableTime = computed(() => (props.def as any).enableTime ?? false);
    const min = computed(() => {
      const m = (props.def as any).min;
      return m?.literalString ?? m ?? "";
    });
    const max = computed(() => {
      const m = (props.def as any).max;
      return m?.literalString ?? m ?? "";
    });

    const inputType = computed(() => {
      if (enableDate.value && enableTime.value) return "datetime-local";
      if (enableTime.value) return "time";
      return "date";
    });

    const { updateFilter, maybeEmit } = useFilterBind(props as any, { op: "eq", nullValue: "" });

    const onInput = (e: Event) => {
      const val = (e.target as HTMLInputElement).value;
      sendEvent("a2ui.dateTimeChange", { componentId: props.componentId, value: val });
      updateFilter(val);
      maybeEmit(val);
    };

    return { label, value, enableDate, enableTime, min, max, inputType, onInput };
  },
});
</script>

<style scoped>
.a2ui-datetime-input {
  color: var(--a2ui-text, inherit);
}
.label-text {
  display: block;
  margin-bottom: 4px;
  font-size: 0.85em;
}
</style>
