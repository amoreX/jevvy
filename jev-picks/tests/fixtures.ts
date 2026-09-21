import type { Brief } from "../src/lib/decision";
export const brief: Brief = {
  objective: "Choose a new skill to learn in three hours a week.",
  facts: ["I know basic JavaScript.", "I have three hours each week."],
  constraints: ["No paid courses."],
  assumptions: ["A computer is available."],
  criteria: [
    {
      id: "time",
      name: "Time fit",
      importance: "high",
      levels: [
        "Cannot start within the available time",
        "Requires more weekly time than available",
        "Fits only by reducing scope",
        "Fits the weekly time with a structured plan",
        "Fits comfortably with flexible short sessions",
      ],
    },
    {
      id: "interest",
      name: "Personal interest",
      importance: "medium",
      levels: [
        "Conflicts with the stated interests",
        "Only tangentially connected to interests",
        "Some connection to stated interests",
        "Directly matches an expressed interest",
        "Matches the person's explicitly stated top interest",
      ],
    },
  ],
  options: [
    {
      id: "web",
      title: "Build a small website",
      description: "Use existing JavaScript skills in a personal project.",
      benefits: ["Builds on existing skills"],
      tradeoffs: ["Requires choosing a small scope"],
      unknowns: ["Preferred project topic"],
      nextStep: "Write down one thing your website should do.",
      eligible: true,
      exclusionReason: "",
    },
    {
      id: "drawing",
      title: "Try digital drawing",
      description: "Practice drawing in short sessions using free software.",
      benefits: ["A creative change of pace"],
      tradeoffs: ["Starts a new skill from scratch"],
      unknowns: ["Interest in visual art"],
      nextStep: "Try one short drawing exercise.",
      eligible: true,
      exclusionReason: "",
    },
    {
      id: "course",
      title: "Join a paid bootcamp",
      description: "Enroll in a paid intensive course.",
      benefits: ["Structured instruction"],
      tradeoffs: ["Requires payment"],
      unknowns: [],
      nextStep: "Check the cost.",
      eligible: false,
      exclusionReason: "Violates the no-paid-courses constraint.",
    },
  ],
};
export function jevResponse() {
  return {
    model: "typesafe/jev-1.13",
    usage: { cost: 0.00009 },
    answers: {
      pick: {
        type: "choice",
        choice: "web",
        confidence: 0.65,
        probabilities: { web: 0.85, drawing: 0.15 },
      },
      score__web__time: {
        type: "score",
        score: 3.4,
        confidence: 0.8,
        probabilities: { "0": 0, "1": 0, "2": 0, "3": 0.6, "4": 0.4 },
      },
      score__web__interest: { type: "score", score: 2.5 },
      score__drawing__time: { type: "score", score: 3.8 },
      score__drawing__interest: { type: "score", score: 1.8 },
    },
  };
}
