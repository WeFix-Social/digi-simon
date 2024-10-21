import { RealtimeClient } from "@openai/realtime-api-beta";
import WebSocket from "ws";
import { instructions } from "./instructions";
import { anspruch } from "./tools";

export class TwilioAgent {
  private twilio: WebSocket;
  private openAi: RealtimeClient | undefined;

  private streamSid: string | undefined;
  private fromNumber: string | undefined;
  private toNumber: string | undefined;

  private sentToOpenAI: number = 0;
  private receivedFromOpenAI: number = 0;

  private sentToTwilio: number = 0;
  private receivedFromTwilio: number = 0;

  private inactivityTimer: NodeJS.Timeout | null = null; // Holds the timer reference
  private timeoutDuration: number = 30000; // ms
  private lastMessageTs: number = 0;

  private updateInactivityTimer(): void {
    this.lastMessageTs = Date.now();
    const delta = Date.now() - this.lastMessageTs;
    console.log("updating inactivity timer", this.lastMessageTs, delta);
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    this.inactivityTimer = setTimeout(() => {
      this.askAgain(); // Function to 'ask again' after the timeout
    }, this.timeoutDuration);
  }

  private askAgain(): void {
    const delta = Date.now() - this.lastMessageTs;
    console.log("lst", this.lastMessageTs);
    console.log("now", Date.now());
    console.log("del", delta);

    if (delta >= this.timeoutDuration) {
      console.log("ASKING AGAIN -- ");
      // this.openAi?.sendUserMessageContent([
      //   { type: "input_text", text: `Ich habe dich nicht verstanden. Kannst du das nochmal wiederholen?`},
      // ]);
      this.openAi?.createResponse();
    }
  }

  constructor(twilioWebSocket: WebSocket) {
    this.twilio = twilioWebSocket;
    this.streamSid = undefined;
  }

  public async setup() {
    await this.setupTwilio();
    await this.setupOpenAI();
  }

  public disconnect() {
    this.openAi?.disconnect();
    this.clearTimers();
  }

  private clearTimers() {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  private getStreamSid(): string | undefined {
    return this.streamSid;
  }

  private async setupOpenAI() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    this.openAi = new RealtimeClient({ apiKey });
    this.addTools();

    this.openAi.updateSession({
      turn_detection: {
        type: "server_vad",
        // default values
        threshold: 0.5,
        prefix_padding_ms: 200,
        silence_duration_ms: 500,
      },
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      voice: "alloy",
      input_audio_transcription: {
        model: "whisper-1",
      },
      instructions,
      modalities: ["text", "audio"],
      temperature: 0.8,
    });

    await this.openAi.connect();
    console.log("OPENAI CONNECTED");

    this.openAi.realtime.on("server.session.updated", (data) => {
      console.log("SESSION UPDATED: ");
    });

    this.openAi.realtime.on("server.response.audio.delta", (data) => {
      try {
        if (data.type === "response.audio.delta" && data.delta) {
          const audioDelta = {
            event: "media",
            streamSid: this.getStreamSid(),
            media: {
              payload: Buffer.from(data.delta, "base64").toString("base64"),
            },
          };
          const message = JSON.stringify(audioDelta);
          if (this.twilio.readyState === WebSocket.OPEN) {
            this.sentToTwilio++;
            this.twilio.send(message);
          } else {
            console.error(
              "Twilio WebSocket connection not open - can't send audio"
            );
          }
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

    this.openAi.realtime.on("server.response.audio_transcript.done", (data) => {
      console.log("ai:", data.transcript);
    });

    this.openAi.realtime.on(
      "server.conversation.item.input_audio_transcription.completed",
      (data) => {
        console.log("user:", data.transcript);
      }
    );

    // Send a item and triggers a generation
    // this.openAi.sendUserMessageContent([
    //   { type: "input_text", text: `Guten Tag!` },
    // ]);

    // force first response
    this.openAi.createResponse();

    this.openAi.realtime.on("server.conversation.item.created", (data) => {
      console.log("conversation.item.created", data);
      this.updateInactivityTimer();
    });

    // all events, can use for logging, debugging, or manual event handling
    // this.openAi.on("realtime.event", ({ time, source, event }) => {
    //   // time is an ISO timestamp
    //   // source is 'client' or 'server'
    //   // event is the raw event payload (json)
    //   if (event.type !== "input_audio_buffer.append") {
    //     console.log("realtime.event", time, source, event);
    //     this.updateInactivityTimer();
    //   }
    // });
  }

  // Initialize the WebSocket connection
  private async setupTwilio() {
    console.log("SETTING UP TWILIO");
    this.twilio.onopen = (event: Event) => {
      console.log("Twilio WebSocket connection opened:", event);
    };

    this.twilio.onmessage = (message: MessageEvent) => {
      this.handleIncomingTwilioMessage(message);
    };

    // this.twilio.onclose = (event: CloseEvent) => {
    //   console.log("Twilio WebSocket connection closed");
    // };

    this.twilio.onerror = (error: Event) => {
      console.error("WebSocket error occurred:", error);
    };
    console.log("TWILIO setup complete");
  }

  private handleIncomingTwilioMessage(message: MessageEvent): void {
    try {
      const dataString = message.data.toString();
      const data = JSON.parse(dataString);

      switch (data.event) {
        case "media":
          this.sendAudioPayloadToOpenAI(data.media.payload);

          break;
        case "start":
          // Example data on start event:
          // {
          //   accountSid: 'ACf3b45a367f25e4893102822eaa42e127',
          //   streamSid: 'MZ5a112b97bb5c1033f4c41011cba7662f',
          //   callSid: 'CAec5d8c2a844f2e3d421444c3a250e53a',
          //   tracks: [ 'inbound' ],
          //   mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
          //   customParameters: {
          //     is_incoming: 'true',
          //     To: '+13053636127',
          //     CallSid: 'CAec5d8c2a844f2e3d421444c3a250e53a',
          //     From: '+4917641083120'
          //  }
          // }
          this.streamSid = data.start.streamSid;
          this.fromNumber = data.start.customParameters.From;
          this.toNumber = data.start.customParameters.To;

          console.log("Incoming stream has started:", data.start);
          break;
        default:
          console.log("Received non-media event:", data.event);
          break;
      }
    } catch (error) {
      console.error("Error parsing message:", error, "Message:", message);
    }
  }

  private sendAudioPayloadToOpenAI(audioInBase64: string) {
    if (!this.openAi) {
      // console.error("OpenAI not initialized - can't send audio");
      return;
    } else if (!this.openAi.isConnected()) {
      // console.error("OpenAI not connected - can't send audio");
    } else {
      // send manually
      this.openAi.realtime.send("input_audio_buffer.append", {
        audio: audioInBase64,
      });

      // send using client:
      // const buffer = Buffer.from(payload, "base64");
      // this.openAi.appendInputAudio(buffer);

      this.sentToOpenAI++;
      // if (this.sentToOpenAI % 10 === 0) {
      //   console.log("SENT TO OPENAI:", this.sentToOpenAI);
      // }
    }
  }

  private addTools() {
    if (!this.openAi) {
      throw new Error("OpenAI not initialized - can't add tools");
    }

    this.openAi.addTool(
      {
        name: "anspruchBerechnen",
        description: "Berechne den Anspruch auf Sozialleistungen",
        parameters: {
          type: "object",
          properties: {
            postleitzahl: {
              type: "string",
              description:
                "Die Postleitzahl des Anrufers: 'In welcher Postleitzahl wohnt ihr?'",
            },
            miete: {
              type: "number",
              description:
                "Die Miete, die der Anrufer zahlt: 'Wie viel Miete zahlt ihr insgesamt?'",
            },
            einkommen: {
              type: "number",
              description:
                "Das monatliche Einkommen des Haushalts des Anrufers: 'Wie viel Geld verdient ihr im Monat?'",
            },
            anzahlErwachsene: {
              type: "number",
              description:
                "Die Anzahl der Erwachsenen im Haushalt des Anrufers: 'Wie viele Erwachsene sind in eurem Haushalt?'",
            },
            anzahlKinder: {
              type: "number",
              description:
                "Die Anzahl der Kinder im Haushalt des Anrufers: 'Wie viele Kinder habt ihr?'",
            },
          },
          required: ["postleitzahl", "partner", "kinder", "miete", "netto"],
        },
      },
      async (input) => {
        return await anspruch(input);
      }
    );
  }
}
