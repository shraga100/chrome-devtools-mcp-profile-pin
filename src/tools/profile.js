/**
 * select_profile tool — added to chrome-devtools-mcp by lib/patch.mjs.
 */
import {selectProfile as selectProfileImpl} from '../profilePin.js';
import {zod} from '../third_party/index.js';
import {ToolCategory} from './categories.js';
import {defineBrowserlessTool} from './ToolDefinition.js';

export const selectProfile = defineBrowserlessTool(() => ({
  name: 'select_profile',
  description:
    'List the Chrome profiles, or choose which Chrome profile this server is attached to when several profiles are open. ' +
    'Call it without arguments to list profiles. Switching disconnects from Chrome and the next browser tool call reconnects ' +
    '(Chrome may show its "Allow remote debugging?" dialog again). Only switch profiles when the user asks for it.',
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    profile: zod
      .string()
      .optional()
      .describe('Profile display name (as shown in Chrome) or folder name (e.g. "Default", "Profile 1"). Omit to list profiles.'),
    remember: zod
      .boolean()
      .optional()
      .describe('Remember the choice for future sessions. Defaults to true.'),
    forget: zod
      .boolean()
      .optional()
      .describe('Clear the remembered choice, so the user is asked again next time several profiles are open.'),
  },
  blockedByDialog: false,
  verifyFilesSchema: {},
  handler: async (request, response) => {
    response.appendResponseLine(await selectProfileImpl(request.params));
  },
}));
