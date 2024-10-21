import Fastify, {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { TwilioAgent } from "./TwilioAgent";

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables. You must have OpenAI Realtime API access.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

// Initialize Fastify
const fastify: FastifyInstance = Fastify({ logger: false });

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
  reply.send({
    message: "Hi, this is Simon. Please direct all calls to: /incoming-call",
  });
});

// Route for Twilio to handle incoming and outgoing calls
// <Say> punctuation to improve text-to-speech translation
fastify.all(
  "/incoming-call",
  async (request: FastifyRequest, reply: FastifyReply) => {
    const From = request.query.From;
    const To = request.query.To;
    const CallSid = request.query.CallSid;

    const twml = `<?xml version="1.0" encoding="UTF-8"?>
                    <Response>
                        <Connect>
                            <Stream url="wss://${request.headers.host}/media-stream" >
                            <Parameter name="is_incoming" value="true"/>
                            <Parameter name="From" value="${From}"/>
                            <Parameter name="To" value="${To}"/>
                            <Parameter name="CallSid" value="${CallSid}"/>
                            </Stream>
                        </Connect>
                    </Response>`;

    reply.type("text/xml").send(twml);
  }
);

// https://www.npmjs.com/package/@fastify/websocket
fastify.register(async function (fastify) {
  fastify.get(
    "/media-stream",
    { websocket: true },
    async (twilioWebSocket /* WebSocket*/, req /* FastifyRequest */) => {
      console.log("Twilio WebSocket media-stream connected");
      let agent = new TwilioAgent(twilioWebSocket as WebSocket);
      await agent.setup();
      // TODO: how to destroy the agent when the connection is closed?

      twilioWebSocket.onclose = (event: CloseEvent) => {
        console.log("Twilio WebSocket connection closed");
        agent.disconnect();
        agent = null;
      };
    }
  );
});

const port: number = parseInt(process.env.PORT || "3000", 10);
const host: string = process.env.HOST || "0.0.0.0";
fastify.listen({ port, host }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }

  // Root Route
  console.log(`Server running: https://${host}:${port}`);
});
