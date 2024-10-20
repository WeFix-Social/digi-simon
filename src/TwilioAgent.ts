import { RealtimeClient } from "@openai/realtime-api-beta";
import WebSocket from "ws";
import { instructions } from "./instructions";

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

  constructor(twilioWebSocket: WebSocket) {
    this.twilio = twilioWebSocket;
    this.streamSid = undefined;
  }

  public async setup() {
    await this.setupTwilio();
    await this.setupOpenAI();
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

    // this.openAi.on("conversation.updated", (event) => {
    // const { item, delta } = event;
    // const items = this.openAi.conversation.getItems();
    /**
     * item is the current item being updated
     * delta can be null or populated
     * you can fetch a full list of items at any time
     */

    // if (delta) {
    // Only one of the following will be populated for any given event
    // delta.audio = Int16Array, audio added
    // delta.transcript = string, transcript added
    // delta.arguments = string, function arguments added
    // const streamSid = this.getStreamSid();
    // if (!streamSid) {
    //   console.error("No streamSid found - can't send audio to Twilio");
    //   return;
    // }

    // if (delta.audio) {
    //   const audioDelta = {
    //     event: "media",
    //     streamSid,
    //     media: {
    //       payload: Buffer.from(delta.audio, "base64").toString("base64"),
    //     },
    //   };
    //   const message = JSON.stringify(audioDelta);
    //   console.log("Sending message to Twilio:", message);
    //   this.twilio.send(message);
    //   this.sentToTwilio++;
    //   // console.log("SENT TO TWILIO:", this.sentToTwilio);
    // }
    // if (delta.transcript) {
    //   this.receivedFromOpenAI++;
    //   console.log("Transcript:", delta.transcript);
    //   // console.log("RECEIVED FROM OPENAI:", this.receivedFromOpenAI);
    // }
    // }
    // });

    await this.openAi.connect();
    console.log("OPENAI CONNECTED");

    this.openAi.realtime.on("server.session.updated", (data) => {
      console.log("SESSION UPDATED: ", data);
    });

    this.openAi.realtime.on("server.response.audio.delta", (data) => {
      try {
        let aiMessage;
        // don't parse if data is not a string
        if (typeof data !== "string") {
          aiMessage = data;
        } else {
          aiMessage = JSON.parse(data);
        }

        if (aiMessage.type === "response.audio.delta" && aiMessage.delta) {
          const audioDelta = {
            event: "media",
            streamSid: this.getStreamSid(),
            media: {
              payload: Buffer.from(aiMessage.delta, "base64").toString(
                "base64"
              ),
            },
          };
          const message = JSON.stringify(audioDelta);
          if (this.twilio.readyState === WebSocket.OPEN) {
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
    this.openAi.sendUserMessageContent([
      { type: "input_text", text: `Guten Tag!` },
    ]);
    this.openAi.createResponse();
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

    this.twilio.onclose = (event: CloseEvent) => {
      console.log("Twilio WebSocket connection closed");
    };

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
          //     {
          //   accountSid: 'ACf3b45a367f25e4893102822eaa42e127',
          // streamSid: 'MZ5a112b97bb5c1033f4c41011cba7662f',
          // callSid: 'CAec5d8c2a844f2e3d421444c3a250e53a',
          // tracks: [ 'inbound' ],
          //         mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
          //         customParameters: {
          //           is_incoming: 'true',
          //           To: '+13053636127',
          //           CallSid: 'CAec5d8c2a844f2e3d421444c3a250e53a',
          //           From: '+4917641083120'
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
      console.error("OpenAI not initialized - can't send audio");
      return;
    } else if (!this.openAi.isConnected()) {
      console.error("OpenAI not connected - can't send audio");
    } else {
      // send manually
      this.openAi.realtime.send("input_audio_buffer.append", {
        audio: audioInBase64,
      });

      // send using client:
      // const buffer = Buffer.from(payload, "base64");
      // this.openAi.appendInputAudio(buffer);

      this.sentToOpenAI++;
      // console.log("SENT TO OPENAI:", this.sentToOpenAI);
    }
  }
}
