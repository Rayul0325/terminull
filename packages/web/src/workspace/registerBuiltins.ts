/**
 * Built-in panel-type registration — the same door the plugin `panels`
 * contribution point will use. Imported once by DockWorkspace.
 */
import { registerPanelType } from './panelRegistry';
import { AgentChatPanel } from './panels/AgentChatPanel';
import { FleetPanel } from './panels/FleetPanel';
import { PlaceholderPanel } from './panels/PlaceholderPanel';
import { SessionPanel } from './panels/SessionPanel';
import { TerminalPanel } from './panels/TerminalPanel';

let registered = false;

export function registerBuiltinPanels(): void {
  if (registered) return;
  registered = true;
  registerPanelType({ id: 'session', titleKey: 'panel.kind.session', Component: SessionPanel });
  registerPanelType({ id: 'terminal', titleKey: 'panel.kind.terminal', Component: TerminalPanel });
  registerPanelType({ id: 'fleet', titleKey: 'panel.kind.fleet', Component: FleetPanel });
  registerPanelType({ id: 'agent', titleKey: 'panel.kind.agent', Component: AgentChatPanel });
  registerPanelType({
    id: 'placeholder',
    titleKey: 'panel.placeholder.title',
    Component: PlaceholderPanel,
  });
}
