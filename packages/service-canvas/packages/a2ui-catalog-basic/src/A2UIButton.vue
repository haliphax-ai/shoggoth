<template>
  <button class="btn" :class="variantClass" :disabled="sentFlash" @click="onClick">
    {{ displayLabel }}
  </button>
</template>

<script lang="ts">
import { defineComponent, computed, ref } from "vue";
import { sendEvent } from "@shoggoth/a2ui-sdk";
import { parseShoggothUrl } from "@shoggoth/a2ui-sdk";

const variantClassMap: Record<string, string> = {
  default: "btn-neutral",
  neutral: "btn-neutral",
  primary: "btn-primary",
  secondary: "btn-secondary",
  accent: "btn-accent",
  info: "btn-info",
  success: "btn-success",
  warning: "btn-warning",
  error: "btn-error",
  borderless: "btn-ghost",
};

export default defineComponent({
  name: "A2UIButton",
  props: {
    def: { type: Object, required: true },
    surfaceId: { type: String, required: true },
    componentId: { type: String, required: true },
  },
  setup(props) {
    const label = computed(() => {
      const t = (props.def as any).label ?? (props.def as any).text;
      return t?.literalString ?? t ?? "Button";
    });
    const variant = computed(() => (props.def as any).variant ?? "default");
    const variantClass = computed(() => variantClassMap[variant.value] ?? "");
    const href = computed(() => (props.def as any).href as string | undefined);
    const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
    const sentFlash = ref(false);
    const displayLabel = computed(() => (sentFlash.value ? "Submitted" : label.value));

    let flashTimer: ReturnType<typeof setTimeout> | null = null;

    const flashSent = () => {
      if (flashTimer) clearTimeout(flashTimer);
      sentFlash.value = true;
      flashTimer = setTimeout(() => {
        sentFlash.value = false;
      }, 3000);
    };

    const onClick = () => {
      sendEvent("a2ui.buttonClick", { componentId: props.componentId });
      if (!href.value) return;
      const parsed = parseShoggothUrl(href.value);
      if (!parsed) return;
      flashSent();
      if (parsed.type === "agent") {
        fetch(`${base}/api/agent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.params),
        }).catch(() => {});
      } else if (parsed.type === "fileprompt") {
        fetch(`${base}/api/file-spawn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: parsed.path, ...parsed.params }),
        }).catch(() => {});
      }
    };
    return { displayLabel, variantClass, onClick, sentFlash };
    return { displayLabel, variantClass, onClick, sentFlash };
  },
});
</script>
