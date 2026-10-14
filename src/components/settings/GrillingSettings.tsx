import { useSettings } from "../../hooks/useSettings";
import { GrillVoicesSettings } from "./GrillVoicesSettings";
import { GrillQuestionsSettings } from "./GrillQuestionsSettings";
import { GrillTopicsCard } from "../GrillTopicsCard";

// The Grilling section of Settings: the "To grill" card, the grill
// voices and the grill questions. Stored keys and behaviour are unchanged.
export default function GrillingSettings() {
  const { grillVoices, setGrillVoices, grillVoiceId, setGrillVoiceId } = useSettings();

  return (
    <div className="space-y-5">
      <GrillTopicsCard />
      <GrillVoicesSettings
        voices={grillVoices}
        voiceId={grillVoiceId}
        onVoicesChange={setGrillVoices}
        onVoiceIdChange={setGrillVoiceId}
      />
      <GrillQuestionsSettings />
    </div>
  );
}
