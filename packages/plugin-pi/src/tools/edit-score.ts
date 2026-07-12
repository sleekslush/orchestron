import { existsSync, writeFileSync } from 'node:fs';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Orchestron } from '../orchestron.js';
import {
  findScoreFile,
  parseAndValidateScore,
  sanitizeScoreId,
  scoreFilePath,
} from './_score-helpers.js';

export interface EditScoreInput {
  scoreId: string;
  yaml: string;
  persist?: boolean;
  saveLocation?: 'local' | 'global';
}

export async function editScore(
  orchestron: Orchestron,
  input: EditScoreInput,
): Promise<{
  scoreId: string;
  persisted: boolean;
  path?: string;
  valid: boolean;
  errors: Array<{ code: string; message: string }>;
}> {
  const scoreId = sanitizeScoreId(input.scoreId);

  let existingPath: string | undefined;
  try {
    orchestron.registry.get(scoreId);
    existingPath = findScoreFile(orchestron.scoresDirs, scoreId);
  } catch {
    return {
      scoreId,
      persisted: false,
      valid: false,
      errors: [
        {
          code: 'INVALID_SCORE',
          message: `Score '${scoreId}' not found. Use orchestron_create_score to create it.`,
        },
      ],
    };
  }

  const { score, errors } = parseAndValidateScore(orchestron.registry, input.yaml);

  if (errors.length > 0) {
    return { scoreId, persisted: false, valid: false, errors };
  }

  if (score.id !== scoreId) {
    return {
      scoreId,
      persisted: false,
      valid: false,
      errors: [
        {
          code: 'INVALID_SCORE',
          message: `YAML id '${score.id}' does not match requested score id '${scoreId}'`,
        },
      ],
    };
  }

  orchestron.registry.remove(scoreId);
  orchestron.registry.register(score);

  if (input.persist) {
    const path = existingPath ?? scoreFilePath(orchestron.scoresDirs, scoreId, input.saveLocation);
    writeFileSync(path, input.yaml, 'utf-8');
    return { scoreId, persisted: true, path, valid: true, errors: [] };
  }

  return { scoreId, persisted: !!existingPath, valid: true, errors: [] };
}

export function editScoreTool(getOrchestron: () => Promise<Orchestron>) {
  return defineTool({
    name: 'orchestron_edit_score',
    label: 'Edit Orchestron Score',
    description:
      'Edit an existing Orchestron score by replacing it with new YAML. The score must already exist in memory or on disk. Set persist: true to write the change back to the file.',
    parameters: Type.Object({
      scoreId: Type.String({
        description:
          'Identifier of the existing score to edit. Must match the id field in the replacement YAML.',
      }),
      yaml: Type.String({
        description: 'Complete replacement YAML content for the score.',
      }),
      persist: Type.Optional(
        Type.Boolean({
          description:
            'If true, save the updated score to the scores directory. Default is false, which updates the in-memory copy only.',
        }),
      ),
      saveLocation: Type.Optional(
        StringEnum(['local', 'global'] as const, {
          description: "Optional location when saving a score that did not exist on disk. 'local' is default.",
        }),
      ),
    }),
    promptSnippet: 'Edit an existing Orchestron score by replacing it with new YAML',
    promptGuidelines: [
      'Use orchestron_edit_score when the user wants to change an existing score.',
      'Use orchestron_get_score first to read the current YAML if the change is specific.',
      'Call with persist: false to preview and validate the change in memory.',
      'Call with persist: true only when the user explicitly asks to save the change.',
      'The scoreId must match the id field in the replacement YAML.',
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const orchestron = await getOrchestron();
      const result = await editScore(orchestron, params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
