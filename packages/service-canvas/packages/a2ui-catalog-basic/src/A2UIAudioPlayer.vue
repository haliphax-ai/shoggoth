<template>
  <div class="a2ui-audio-player">
    <span v-if="description" class="a2ui-audio-description">{{ description }}</span>
    <audio
      ref="audioEl"
      :src="resolvedUrl"
      :autoplay="autoplay"
      :loop="loop"
      :muted="isMuted"
      preload="metadata"
      @loadedmetadata="onLoadedMetadata"
      @timeupdate="onTimeUpdate"
      @play="onPlay"
      @pause="onPause"
      @ended="onEnded"
      @volumechange="onVolumeChange"
    />
    <div class="a2ui-audio-controls">
      <button
        class="btn btn-sm btn-ghost"
        @click="togglePlay"
        :aria-label="isPlaying ? 'Pause' : 'Play'"
      >
        {{ isPlaying ? iconPause : iconPlay }}
      </button>
      <span class="a2ui-audio-time">{{ formatTime(currentTime) }}</span>
      <input
        type="range"
        class="range range-xs a2ui-audio-seek"
        min="0"
        :max="duration"
        :value="currentTime"
        step="any"
        @input="onSeek"
        aria-label="Seek"
      />
      <span class="a2ui-audio-time">{{ formatTime(duration) }}</span>
      <button
        class="btn btn-sm btn-ghost"
        @click="toggleMute"
        :aria-label="isMuted ? 'Unmute' : 'Mute'"
      >
        {{ isMuted ? "🔇" : "🔊" }}
      </button>
      <input
        type="range"
        class="range range-xs a2ui-audio-volume"
        min="0"
        max="1"
        :value="isMuted ? 0 : volume"
        step="0.01"
        @input="onVolume"
        aria-label="Volume"
      />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, onBeforeUnmount } from "vue";
import { sendEvent } from "@shoggoth/a2ui-sdk";
import { rewriteCanvasUrl } from "./url-rewriter";

/** Emoji presentation (U+FE0F) so play/pause match width/font with each other */
const ICON_PLAY = "\u25B6\uFE0F";
const ICON_PAUSE = "\u23F8\uFE0F";

export default defineComponent({
  name: "A2UIAudioPlayer",
  props: {
    def: { type: Object, required: true },
    componentId: { type: String, required: true },
    surfaceId: { type: String, default: "" },
  },
  setup(props) {
    const audioEl = ref<HTMLAudioElement | null>(null);
    const isPlaying = ref(false);
    const currentTime = ref(0);
    const duration = ref(0);
    const volume = ref(1);
    const isMuted = ref(false);

    const resolvedUrl = computed(() => rewriteCanvasUrl((props.def as any).url ?? ""));
    const description = computed(() => (props.def as any).description ?? "");
    const autoplay = computed(() => (props.def as any).autoplay ?? false);
    const loop = computed(() => (props.def as any).loop ?? false);

    onMounted(() => {
      if ((props.def as any).muted) {
        isMuted.value = true;
      }
    });

    const formatTime = (t: number) => {
      if (!isFinite(t) || t < 0) return "0:00";
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      return `${m}:${s.toString().padStart(2, "0")}`;
    };

    const togglePlay = () => {
      const el = audioEl.value;
      if (!el) return;
      if (el.paused) el.play();
      else el.pause();
    };

    const toggleMute = () => {
      const el = audioEl.value;
      if (!el) return;
      el.muted = !el.muted;
      isMuted.value = el.muted;
    };

    const onSeek = (e: Event) => {
      const el = audioEl.value;
      if (!el) return;
      el.currentTime = Number((e.target as HTMLInputElement).value);
    };

    const onVolume = (e: Event) => {
      const el = audioEl.value;
      if (!el) return;
      const val = Number((e.target as HTMLInputElement).value);
      el.volume = val;
      volume.value = val;
      if (val > 0 && el.muted) {
        el.muted = false;
        isMuted.value = false;
      }
    };

    const onLoadedMetadata = () => {
      const el = audioEl.value;
      if (el) duration.value = el.duration;
    };

    const onTimeUpdate = () => {
      const el = audioEl.value;
      if (el) currentTime.value = el.currentTime;
    };

    const onPlay = () => {
      isPlaying.value = true;
      sendEvent("a2ui.audioPlay", { componentId: props.componentId });
    };

    const onPause = () => {
      isPlaying.value = false;
      sendEvent("a2ui.audioPause", { componentId: props.componentId });
    };

    const onEnded = () => {
      isPlaying.value = false;
      sendEvent("a2ui.audioEnded", { componentId: props.componentId });
    };

    const onVolumeChange = () => {
      const el = audioEl.value;
      if (el) {
        volume.value = el.volume;
        isMuted.value = el.muted;
      }
    };

    return {
      iconPlay: ICON_PLAY,
      iconPause: ICON_PAUSE,
      audioEl,
      resolvedUrl,
      description,
      autoplay,
      loop,
      isPlaying,
      currentTime,
      duration,
      volume,
      isMuted,
      formatTime,
      togglePlay,
      toggleMute,
      onSeek,
      onVolume,
      onLoadedMetadata,
      onTimeUpdate,
      onPlay,
      onPause,
      onEnded,
      onVolumeChange,
    };
  },
});
</script>

<style scoped>
.a2ui-audio-player {
  color: var(--a2ui-text);
  width: 100%;
}
.a2ui-audio-description {
  display: block;
  margin-bottom: 4px;
  font-size: 0.85em;
}
.a2ui-audio-controls {
  display: flex;
  align-items: center;
  gap: 4px;
}
.a2ui-audio-seek {
  flex: 1;
  accent-color: var(--a2ui-primary);
}
.a2ui-audio-volume {
  width: 80px;
  accent-color: var(--a2ui-primary);
}
.a2ui-audio-time {
  font-size: 0.75em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
