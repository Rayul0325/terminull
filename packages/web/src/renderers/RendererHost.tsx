/**
 * Renders one ChatItem through the registry with per-item error isolation:
 * a throwing renderer (first-party or plugin) is replaced by an honest error
 * chip + the generic fallback — it can never blank the transcript.
 */
import { Component, type ReactElement, type ReactNode } from 'react';
import { GenericItem } from './GenericItem';
import { resolveRenderer, type RendererProps } from './registry';

interface BoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
  label: string;
}

interface BoundaryState {
  failed: boolean;
}

class ItemErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false };

  // Renderer crashes are UI-local; the honest chip below is the signal.
  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div>
          <span className="tn-chip" style={{ color: 'var(--tn-danger)' }}>
            {this.props.label}
          </span>
          {this.props.fallback}
        </div>
      );
    }
    return this.props.children;
  }
}

export function RendererHost({ item, ctx }: RendererProps): ReactElement {
  const spec = resolveRenderer(item, ctx.adapterId);
  const Renderer = spec.Component;
  return (
    <ItemErrorBoundary
      label={ctx.t('chat.rendererFailed', { id: spec.id })}
      fallback={<GenericItem item={item} ctx={ctx} />}
    >
      <Renderer item={item} ctx={ctx} />
    </ItemErrorBoundary>
  );
}
