import { z } from "zod";

import { tool } from "@langchain/core/tools";

export async function anspruch(input: any) {
  console.log("Anspruch: input=", input);
  const response = await fetch("http://localhost:5173/api/anspruchEinfach", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const data = await response.json();
  console.log("Anspruch: response=", data);

  return JSON.stringify(data);
}

const anspruchBerechnen = tool(
  async (input) => {
    return await anspruch(input);
  },
  {
    name: "anspruchBerechnen",
    description: "Berechne den Anspruch auf Sozialleistungen",
    schema: z.object({
      postleitzahl: z.string().describe("Die Postleitzahl des Anrufers"),
      partner: z
        .boolean()
        .describe("Ob der Anrufer allein oder mit einem Partner lebt"),
      kinder: z
        .number()
        .describe("Die Anzahl der Kinder im Haushalt des Anrufers"),
      miete: z.number().describe("Die Miete, die der Anrufer zahlt"),
      netto: z.number().describe("Das Nettogehalt des Anrufers"),
    }),
  }
);

export const TOOLS = [anspruchBerechnen];
