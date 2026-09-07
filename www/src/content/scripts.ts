import type { ScriptStep } from "@/components/overlay/OverlayCard";
import type { Turn } from "@/components/overlay/pieces";
import type { Rec } from "@/components/overlay/RecommendationCard";

// Scripted playbacks for the overlay replica. Times in ms from loop start.
// Scenarios come from the recommendation fixtures the app is tested against
// (tests/fixtures/recommendations): budget phasing, red lines, priorities.
// Lines are short on purpose: the card is read at a glance, mid-meeting.

const t = (id: string, channel: Turn["channel"], text: string): Turn => ({
  id,
  channel,
  text,
});

const HERO_ANSWER: Rec = {
  title: "Answer",
  say: "Net-60 is within policy if the annual commitment stays.",
  avoid: "Don't quote net-90. Terms are capped at 60 days.",
  grounded: 94,
  source: "finance/payment-terms-2026.pdf · p.2",
};

const H1 = t("h1", "other", "The total works for us.");
const H2 = t("h2", "other", "But Q1 is tight. Could you do net-90?");
const H3 = t("h3", "selfSpeaker", "Which Q1 line is the constraint?");

export const HERO_SCRIPT: ScriptStep[] = [
  { at: 0, state: { turns: [], status: "listening", rec: null } },
  { at: 1100, state: { turns: [H1] } },
  { at: 2400, state: { turns: [H1, { ...H2, interim: true }] } },
  { at: 3300, state: { turns: [H1, H2] } },
  { at: 3700, state: { status: "checking" } },
  { at: 5000, state: { status: "question" } },
  { at: 6400, state: { status: "listening", rec: HERO_ANSWER } },
  { at: 9000, state: { turns: [H1, H2, H3] } },
  { at: 14200, state: { rec: null } },
  { at: 15300, state: { turns: [] } },
];

const RED_LINE: Rec = {
  title: "Red line",
  say: "May is what delivery signed off. Offer a March pilot.",
  avoid: "Don't agree to a Q1 launch.",
  grounded: 100,
  source: "brief · Red lines",
};

const R1 = t("r1", "other", "We need this live by end of Q1. That's firm.");
const R2 = t("r2", "selfSpeaker", "Understood. Here's what a March pilot covers.");

export const REASONS_SCRIPT: ScriptStep[] = [
  { at: 0, state: { turns: [], status: "listening", rec: null } },
  { at: 900, state: { turns: [R1] } },
  { at: 2200, state: { status: "checking" } },
  { at: 3400, state: { status: "risk" } },
  { at: 4700, state: { status: "listening", rec: RED_LINE } },
  { at: 7800, state: { turns: [R1, R2] } },
  { at: 10800, state: { rec: null } },
  { at: 11600, state: { status: "manual" } },
  {
    at: 13000,
    state: {
      status: "listening",
      rec: {
        title: "Advice",
        say: "Ask them to rank speed, customisation and cost.",
        grounded: 91,
        source: "brief · Questions to ask",
      },
    },
  },
  { at: 17200, state: { rec: null } },
  { at: 18000, state: { turns: [] } },
];
