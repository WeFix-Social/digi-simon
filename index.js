import Fastify from "fastify";
import WebSocket from "ws";
import fs from "fs";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables. You must have OpenAI Realtime API access.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const systemMessageSimon = `
Du bist ein ein digitaler Sozialberater Namens Digi-Simon.
Du beantwortest Anrufe von Menschen, die sich informieren wollen, ob sie Sozialleistungen beziehen können und wie hoch der potenzielle Anspruch ist.
Dein Ziel ist es Menschen zu helfen herauszufinden, ob ihnen Sozialleistungen zustehen und wie hoch der potenzielle Anspruch ist.
Zuerst grüße den Nutzer, stelle dich vor und erkläre ihm, dass du ihm bei der Suche nach Sozialleistungen helfen kannst.

Um das herauszufinden, stellst du der Person, die du berprft, Fragen um herauszufinden:
- in welcher Postleitzahl sie wohnen
- ob sie allein oder mit einem Partner leben
- wie viele Kinder sie haben
- wie viel Miete sie zahlen
- ob sie arbeiten und wie viel sie Netto im Monat verdienen


Dann berechne den Anspruch auf Sozialleistungen und antworte in einem Satz, wie hoch der Anspruch ist.

Spreche Deutsch aber ändere die Sprache falls der Anrufer das will.
`;

const toolTestMessage = `
Sage "Hallo, ich rechne .."
dann Berechne den Anspruch auf Sozialleistungen basierend auf den bereitgestellten Parametern:
plz: 10115,
warmmiete: 500,
kinderAnzahl: 2,
nettoEinkommen: 1500

dann gib das Ergebnis in einem Satz wieder.
`;
const tools = {
  name: "anspruchBerechnen",
  description:
    "Berechnet den Anspruch auf Sozialleistungen basierend auf den bereitgestellten Parametern",
  parameters: {
    type: "object",
    properties: {
      postleitzahl: {
        type: "string",
        description: "Postleitzahl der Wohnung",
      },
      warmmiete: {
        type: "number",
        description: "Warmmiete pro Monat",
      },
      kinderAnzahl: {
        type: "number",
        description: "Anzahl der Kinder im Haushalt",
      },
      nettoEinkommen: {
        type: "number",
        description: "Nettoverdienst pro Monat",
      },
    },
    required: ["postleitzahl", "warmmiete", "kinderAnzahl", "nettoEinkommen"],
  },
};

const VOICE = "alloy";
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment
console.log("got process.env.PORT", process.env.PORT);

// List of Event Types to log to the console. See OpenAI Realtime API Documentation. (session.updated is handled separately.)
const LOG_EVENT_TYPES = [
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
];

// Root Route
fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

// Route for Twilio to handle incoming and outgoing calls
// <Say> punctuation to improve text-to-speech translation
fastify.all("/incoming-call", async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Open-A.I. Realtime API</Say>
                              <Pause length="1"/>
                              <Say>O.K. you can start talking!</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

  const twimlResponse2 = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

  console.log("request", request.body);
  reply.type("text/xml").send(twimlResponse2);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected");

    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    let streamSid = null;

    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          // instructions: toolTestMessage,
          instructions: systemMessageSimon,
          modalities: ["text", "audio"],
          temperature: 0.8,

          tools: [tools],
        },
      };

      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    // Open event for OpenAI WebSocket
    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API");
      setTimeout(sendSessionUpdate, 250); // Ensure connection stability, send after .25 seconds
    });

    // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }

        if (response.type === "session.updated") {
          console.log("Session updated successfully:", response);
        }

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: {
              payload: Buffer.from(response.delta, "base64").toString("base64"),
            },
          };
          connection.send(JSON.stringify(audioDelta));
        }
      } catch (error) {
        console.error(
          "Error processing OpenAI message:",
          error,
          "Raw message:",
          data
        );
      }
    });

    // Handle incoming messages from Twilio
    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case "media":
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              };

              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
          case "start":
            streamSid = data.start.streamSid;
            console.log("Incoming stream has started", streamSid);
            break;
          default:
            console.log("Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("Error parsing message:", error, "Message:", message);
      }
    });

    // Handle connection close
    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log("Client disconnected.");
    });

    // Handle WebSocket close and errors
    openAiWs.on("close", () => {
      console.log("Disconnected from the OpenAI Realtime API");
    });

    openAiWs.on("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error);
    });
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
