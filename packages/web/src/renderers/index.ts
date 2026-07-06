/**
 * Renderer registration manifest. Importing this module registers the
 * built-in renderers; renderer packets append EXACTLY ONE import line each
 * (see RENDERERS.md). Registration order is the specificity tiebreak, so the
 * generic fallback stays FIRST (it matches everything at specificity 0 and
 * must lose every tie it can).
 */
import { registerRenderer } from './registry';
import { GenericItem } from './GenericItem';
import { TextMessage } from './TextMessage';
import { BashCard } from './tools/BashCard';
import { WriteCard } from './tools/WriteCard';

registerRenderer({ id: 'generic', match: {}, Component: GenericItem });
registerRenderer({ id: 'kind.message', match: { kind: 'message' }, Component: TextMessage });
registerRenderer({
  id: 'tool.bash',
  match: { kind: 'tool_call', toolName: 'Bash' },
  Component: BashCard,
});
registerRenderer({
  id: 'tool.write',
  match: { kind: 'tool_call', toolName: 'Write' },
  Component: WriteCard,
});

import './kinds/ReasoningView';
import './kinds/SidechainView';
import './kinds/SystemView';
import './kinds/ToolResultView';
import './tools/AgentCard';
import './tools/AskUserQuestionCard';
import './tools/EditCard';
import './tools/ExitPlanModeCard';
import './tools/GlobCard';
import './tools/GrepCard';
import './tools/ReadCard';
import './tools/TodoWriteCard';

export { RendererHost } from './RendererHost';
export * from './registry';
