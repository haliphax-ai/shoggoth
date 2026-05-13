<template>
  <label class="a2ui-textfield form-control w-full">
    <span v-if="labelText" class="label-text">{{ labelText }}</span>
    <textarea
      v-if="isLongText"
      class="textarea textarea-bordered w-full"
      :placeholder="placeholder"
      :value="valueText"
      :aria-label="ariaLabelOnly || undefined"
      :aria-describedby="describedBy || undefined"
      :aria-invalid="hasValidationIssue || undefined"
      @input="onInput"
    />
    <input
      v-else
      class="input input-bordered w-full"
      :type="inputType"
      :placeholder="placeholder"
      :value="valueText"
      :pattern="validationRegexp || undefined"
      :aria-label="ariaLabelOnly || undefined"
      :aria-describedby="describedBy || undefined"
      :aria-invalid="hasValidationIssue || undefined"
      @input="onInput"
    />
    <span v-if="hintText" :id="hintId" class="a2ui-field-hint">{{ hintText }}</span>
    <ul v-if="failedCheckMessages.length" :id="checksId" class="a2ui-field-checks" role="alert">
      <li v-for="(msg, i) in failedCheckMessages" :key="i">{{ msg }}</li>
    </ul>
  </label>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";
import { useStore } from "vuex";
import {
  sendEvent,
  useFilterBind,
  resolveDynamicString,
  resolveDynamicBoolean,
} from "@shoggoth/a2ui-sdk";

export default defineComponent({
  name: "A2UITextField",
  props: {
    def: { type: Object, required: true },
    surfaceId: { type: String, required: true },
    componentId: { type: String, required: true },
  },
  setup(props) {
    const store = useStore();

    const dataModel = computed((): Record<string, unknown> => {
      const s = store.state.a2ui?.surfaces?.[props.surfaceId];
      return (s?.dataModel ?? {}) as Record<string, unknown>;
    });

    const labelText = computed(() =>
      resolveDynamicString((props.def as any).label, dataModel.value),
    );

    const valueText = computed(() =>
      resolveDynamicString((props.def as any).value, dataModel.value),
    );

    const variant = computed(() => (props.def as any).variant ?? "shortText");
    const isLongText = computed(() => variant.value === "longText");

    const placeholder = computed(() => {
      const p = (props.def as any).placeholder;
      return typeof p === "string" ? p : resolveDynamicString(p, dataModel.value);
    });

    const validationRegexp = computed(() => (props.def as any).validationRegexp ?? "");

    const accessibility = computed(
      () => (props.def as any).accessibility as Record<string, unknown> | undefined,
    );

    const ariaLabelOnly = computed(() => {
      const raw = accessibility.value?.label;
      if (raw === undefined || raw === null) return "";
      const s = resolveDynamicString(raw, dataModel.value);
      return s || "";
    });

    const hintText = computed(() => {
      const raw = accessibility.value?.description;
      if (raw === undefined || raw === null) return "";
      return resolveDynamicString(raw, dataModel.value);
    });

    const hintId = computed(() => `a2ui-tf-${props.componentId}-hint`);
    const checksId = computed(() => `a2ui-tf-${props.componentId}-checks`);

    const failedCheckMessages = computed((): string[] => {
      const checks = (props.def as any).checks;
      if (!Array.isArray(checks)) return [];
      const out: string[] = [];
      for (const c of checks) {
        if (!c || typeof c !== "object") continue;
        const cond = resolveDynamicBoolean((c as any).condition, dataModel.value);
        const msg = (c as any).message;
        if (typeof msg !== "string") continue;
        // v0.9: condition is validity — show message when invalid (false)
        if (cond === false) out.push(msg);
      }
      return out;
    });

    const describedBy = computed(() => {
      const parts: string[] = [];
      if (hintText.value) parts.push(hintId.value);
      if (failedCheckMessages.value.length) parts.push(checksId.value);
      return parts.length ? parts.join(" ") : "";
    });

    const hasValidationIssue = computed(() => failedCheckMessages.value.length > 0);

    const inputType = computed(() => {
      switch (variant.value) {
        case "number":
          return "number";
        case "obscured":
          return "password";
        default:
          return "text";
      }
    });

    const { updateFilter, maybeEmit } = useFilterBind(props as any, { op: "eq", nullValue: "" });

    const onInput = (e: Event) => {
      const val = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
      sendEvent("a2ui.textFieldChange", { componentId: props.componentId, value: val });
      updateFilter(val);
      maybeEmit(val);
    };

    return {
      labelText,
      valueText,
      variant,
      isLongText,
      placeholder,
      validationRegexp,
      inputType,
      onInput,
      ariaLabelOnly,
      hintText,
      hintId,
      checksId,
      failedCheckMessages,
      describedBy,
      hasValidationIssue,
    };
  },
});
</script>

<style scoped>
.a2ui-textfield {
  color: var(--a2ui-text, inherit);
}
.label-text {
  display: block;
  margin-bottom: 4px;
  font-size: 0.85em;
}
.a2ui-field-hint {
  display: block;
  margin-top: 4px;
  font-size: 0.8em;
  opacity: 0.75;
}
.a2ui-field-checks {
  margin: 6px 0 0;
  padding-left: 1.1em;
  font-size: 0.8em;
  color: var(--color-error, #f87171);
  list-style: disc;
}
</style>
