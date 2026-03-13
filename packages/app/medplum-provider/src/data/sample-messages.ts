// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sample message thread - provider and patient back-and-forth.
 * Used by the Get Started page to seed sample messaging data.
 */
export const SAMPLE_MESSAGES = [
  {
    sender: 'patient' as const,
    text: "Hi Doctor! I've been having some fatigue the past couple weeks — just really tired by mid-afternoon even after a full night's sleep. Is that something I should get checked out?",
    sentOffsetMinutes: -58,
  },
  {
    sender: 'provider' as const,
    text: "Hi David! That's worth looking into. Fatigue can have many causes — sleep quality, stress, thyroid, or vitamin levels. Have you had any changes in diet, stress, or routine lately?",
    sentOffsetMinutes: -52,
  },
  {
    sender: 'patient' as const,
    text: "Work has been pretty stressful. I've also been skipping lunch a lot and probably not eating as well. Would you recommend I come in for bloodwork?",
    sentOffsetMinutes: -45,
  },
  {
    sender: 'provider' as const,
    text: "That would be a good next step. Let's order a CBC, metabolic panel, TSH, and vitamin D — those will help rule out common causes. I'll put the orders in and you can stop by the lab whenever convenient. No fasting needed for the vitamin D.",
    sentOffsetMinutes: -38,
  },
  {
    sender: 'patient' as const,
    text: "Sounds good, thanks! Should I also try to improve my eating and sleep habits while we wait for results?",
    sentOffsetMinutes: -30,
  },
  {
    sender: 'provider' as const,
    text: "Absolutely — that can only help. Try regular meals (even something small at lunch) and aim for consistent sleep times. Sometimes stress and irregular eating alone can explain fatigue. We'll have a clearer picture once the labs are back.",
    sentOffsetMinutes: -22,
  },
  {
    sender: 'patient' as const,
    text: "I'll give it a shot. Really appreciate the quick response!",
    sentOffsetMinutes: -15,
  },
  {
    sender: 'provider' as const,
    text: "Happy to help. Reach out if you have any questions once the results come in.",
    sentOffsetMinutes: -10,
  },
];
