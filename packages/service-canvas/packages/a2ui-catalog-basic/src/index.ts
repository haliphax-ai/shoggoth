import type { PackageDefinition } from "@shoggoth/a2ui-sdk";
import A2UIColumn from "./A2UIColumn.vue";
import A2UIRow from "./A2UIRow.vue";
import A2UIText from "./A2UIText.vue";
import A2UIButton from "./A2UIButton.vue";
import A2UIImage from "./A2UIImage.vue";
import A2UITabs from "./A2UITabs.vue";
import A2UIDivider from "./A2UIDivider.vue";
import A2UISlider from "./A2UISlider.vue";
import A2UICheckbox from "./A2UICheckbox.vue";
import A2UIChoicePicker from "./A2UIChoicePicker.vue";
import A2UIList from "./A2UIList.vue";
import A2UICard from "./A2UICard.vue";
import A2UIModal from "./A2UIModal.vue";
import A2UITextField from "./A2UITextField.vue";
import A2UIDateTimeInput from "./A2UIDateTimeInput.vue";
import A2UIIcon from "./A2UIIcon.vue";
import A2UIAudioPlayer from "./A2UIAudioPlayer.vue";
import A2UIVideo from "./A2UIVideo.vue";

const definition: PackageDefinition = {
  components: [
    { name: "Column", component: A2UIColumn },
    { name: "Row", component: A2UIRow },
    { name: "Text", component: A2UIText },
    { name: "Button", component: A2UIButton },
    { name: "Image", component: A2UIImage },
    { name: "Tabs", component: A2UITabs },
    { name: "Divider", component: A2UIDivider },
    { name: "Slider", component: A2UISlider },
    { name: "Checkbox", component: A2UICheckbox },
    { name: "ChoicePicker", component: A2UIChoicePicker },
    { name: "List", component: A2UIList },
    { name: "Card", component: A2UICard },
    { name: "Modal", component: A2UIModal },
    { name: "TextField", component: A2UITextField },
    { name: "DateTimeInput", component: A2UIDateTimeInput },
    { name: "Icon", component: A2UIIcon },
    { name: "AudioPlayer", component: A2UIAudioPlayer },
    { name: "Video", component: A2UIVideo },
  ],
};

export default definition;
