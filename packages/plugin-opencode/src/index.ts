import { type Plugin, tool } from "@opencode-ai/plugin";
import type { HarnessAdapter } from "@orchestron/core";
import {
  createOrchestron,
  startConcert,
  getConcertStatus,
  listConcerts,
  pauseConcert,
  cancelConcert,
  waitForConcert,
  listScores,
  getScore,
  createScore,
  editScore,
} from "@orchestron/plugin-common";
import type { ListConcertsInput } from "@orchestron/plugin-common";
import { PiAdapter } from "@orchestron/adapter-pi";
import { OpencodeAdapter } from "@orchestron/adapter-opencode";

let orchestronPromise: ReturnType<typeof createOrchestron> | undefined;

async function getOrchestron() {
  if (!orchestronPromise) {
    orchestronPromise = createOrchestron({
      adapters: new Map<string, HarnessAdapter>([
        ["pi", new PiAdapter()],
        ["opencode", new OpencodeAdapter({ embedded: { port: 0 } })],
      ]),
    });
  }
  return orchestronPromise;
}

export const OrchestronPlugin: Plugin = async () => ({
  tool: {
    orchestron_start_concert: tool({
      description:
        "Start a new Orchestron concert from a registered score. The concert runs in the background and can be monitored with orchestron_get_concert_status.",
      args: {
        scoreId: tool.schema
          .string()
          .describe("ID of the registered score to run"),
        context: tool.schema
          .object({})
          .optional()
          .describe("Optional initial context values for the concert"),
      },
      async execute(args) {
        const o = await getOrchestron();
        return JSON.stringify(await startConcert(o, args));
      },
    }),

    orchestron_get_concert_status: tool({
      description:
        "Get the current status, movement history, resource usage, and current movement progress of an Orchestron concert.",
      args: {
        concertId: tool.schema
          .string()
          .describe("ID of the concert to check"),
      },
      async execute(args) {
        const o = await getOrchestron();
        return JSON.stringify(await getConcertStatus(o, args));
      },
    }),

    orchestron_list_concerts: tool({
      description:
        "List Orchestron concerts, optionally filtered by status, with limit and offset pagination.",
      args: {
        status: tool.schema
          .string()
          .optional()
          .describe(
            "Filter by status: pending, running, paused, completed, failed, cancelled",
          ),
        limit: tool.schema
          .number()
          .optional()
          .describe("Maximum number of concerts to return"),
        offset: tool.schema
          .number()
          .optional()
          .describe("Number of concerts to skip"),
      },
      async execute(args) {
        const o = await getOrchestron();
        return JSON.stringify(
          await listConcerts(o, args as ListConcertsInput),
        );
      },
    }),

    orchestron_pause_concert: tool({
      description: "Pause a running Orchestron concert.",
      args: {
        concertId: tool.schema
          .string()
          .describe("ID of the concert to pause"),
      },
      async execute(args) {
        const o = await getOrchestron();
        return JSON.stringify(await pauseConcert(o, args));
      },
    }),

    orchestron_cancel_concert: tool({
      description: "Cancel a running or paused Orchestron concert.",
      args: {
        concertId: tool.schema
          .string()
          .describe("ID of the concert to cancel"),
      },
      async execute(args) {
        const o = await getOrchestron();
        return JSON.stringify(await cancelConcert(o, args));
      },
    }),

    orchestron_wait_for_concert: tool({
      description:
        "Block until an Orchestron concert reaches a terminal state. Returns the final concert status, movement history, and resource usage.",
      args: {
        concertId: tool.schema
          .string()
          .describe("ID of the concert to wait for"),
      },
      async execute(args) {
        const o = await getOrchestron();
        return JSON.stringify(await waitForConcert(o, args));
      },
    }),

    orchestron_list_scores: tool({
      description:
        "List all registered Orchestron scores and their movements.",
      args: {},
      async execute() {
        const o = await getOrchestron();
        return JSON.stringify(await listScores(o));
      },
    }),

    orchestron_get_score: tool({
      description:
        "Get the full YAML and file path of an existing Orchestron score. If the score only exists in memory, returns empty YAML.",
      args: {
        scoreId: tool.schema
          .string()
          .describe("ID of the score to retrieve"),
      },
      async execute(args) {
        const o = await getOrchestron();
        return JSON.stringify(await getScore(o, args));
      },
    }),

    orchestron_create_score: tool({
      description:
        "Create a new Orchestron score from a complete YAML definition. The score is validated and registered in memory. Set persist: true to save it to the scores directory.",
      args: {
        scoreId: tool.schema
          .string()
          .describe(
            "Unique identifier for the score. Must match the id field in the YAML.",
          ),
        yaml: tool.schema
          .string()
          .describe(
            "Complete YAML content of the score. Must include id, name, version, startMovement, program, and movements.",
          ),
        persist: tool.schema
          .boolean()
          .optional()
          .describe(
            "If true, save the score to disk after validation. Default false keeps it in memory only.",
          ),
        saveLocation: tool.schema
          .string()
          .optional()
          .describe(
            "Where to save: 'local' (./.orchestron/scores/) or 'global' (~/.orchestron/scores/). Default 'local'.",
          ),
      },
      async execute(args) {
        const o = await getOrchestron();
        return JSON.stringify(await createScore(o, args as any));
      },
    }),

    orchestron_edit_score: tool({
      description:
        "Edit an existing Orchestron score by replacing it with new YAML. The score must already exist in memory or on disk.",
      args: {
        scoreId: tool.schema
          .string()
          .describe(
            "Identifier of the existing score to edit. Must match the id field in the replacement YAML.",
          ),
        yaml: tool.schema
          .string()
          .describe("Complete replacement YAML content for the score."),
        persist: tool.schema
          .boolean()
          .optional()
          .describe(
            "If true, save the updated score to disk. Default false updates the in-memory copy only.",
          ),
        saveLocation: tool.schema
          .string()
          .optional()
          .describe(
            "Optional location when saving a score that did not exist on disk. 'local' is default.",
          ),
      },
      async execute(args) {
        const o = await getOrchestron();
        return JSON.stringify(await editScore(o, args as any));
      },
    }),
  },
});

export default OrchestronPlugin;
