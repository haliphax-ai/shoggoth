<template>
  <div class="a2ui-video">
    <video
      ref="videoEl"
      :src="resolvedUrl"
      :autoplay="autoplay"
      :loop="loop"
      :muted="isMuted"
      :controls="controls"
      :poster="resolvedPoster"
      preload="metadata"
      class="a2ui-video-element"
      @play="onPlay"
      @pause="onPause"
      @ended="onEnded"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted } from "vue";
import { sendEvent } from "@shoggoth/a2ui-sdk";
import { rewriteCanvasUrl } from "./url-rewriter";

export default defineComponent({
  name: "A2UIVideo",
  props: {
    def: { type: Object, required: true },
    componentId: { type: String, required: true },
    surfaceId: { type: String, default: "" },
  },
  setup(props) {
    const videoEl = ref<HTMLVideoElement | null>(null);
    const isMuted = ref(false);

    const resolvedUrl = computed(() =>
      rewriteCanvasUrl((props.def as any).url ?? (props.def as any).src ?? ""),
    );
    const autoplay = computed(() => (props.def as any).autoplay ?? false);
    const loop = computed(() => (props.def as any).loop ?? false);
    const controls = computed(() => (props.def as any).controls ?? true);
    const resolvedPoster = computed(() => {
      const poster = (props.def as any).poster;
      return poster ? rewriteCanvasUrl(poster) : undefined;
    });

    onMounted(() => {
      if ((props.def as any).muted) {
        isMuted.value = true;
      }
    });

    const onPlay = () => {
      sendEvent("a2ui.videoPlay", { componentId: props.componentId });
    };

    const onPause = () => {
      sendEvent("a2ui.videoPause", { componentId: props.componentId });
    };

    const onEnded = () => {
      sendEvent("a2ui.videoEnded", { componentId: props.componentId });
    };

    return {
      videoEl,
      resolvedUrl,
      autoplay,
      loop,
      isMuted,
      controls,
      resolvedPoster,
      onPlay,
      onPause,
      onEnded,
    };
  },
});
</script>

<style scoped>
.a2ui-video {
  width: 100%;
}
.a2ui-video-element {
  width: 100%;
  height: auto;
  display: block;
  border-radius: var(--rounded-box, 0.5rem);
}
</style>
