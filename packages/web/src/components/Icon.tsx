/**
 * Minimal stroke icon set (Lucide-derived), ported from the control-tower
 * cockpit. Every icon is currentColor, no emoji — this keeps the warm-editorial
 * UI from reading "AI-generated". Icons are built from static, trusted element
 * specs (tag + attrs) via React.createElement — never raw-HTML injection.
 *
 * FILL icons (recording, play, pause, stop, dot, and the small "info-dot"
 * parts) carry a per-part `fill: currentColor` override on top of the default
 * `fill: none` stroke rendering.
 */
import { createElement, type ReactElement } from 'react';

/** Per-part override that turns a stroke shape into a solid fill. */
const FILL = { fill: 'currentColor', stroke: 'none' } as const;

/**
 * Icon spec map. Each entry is a list of [svgTag, attrs] parts. `as const`
 * keeps the keys literal so `IconName` is the exact union of icon names.
 */
const ICONS = {
  // ---- ported from control-tower app.js (radar → external) ----
  radar: [
    ['circle', { cx: 12, cy: 12, r: 2.5 }],
    ['circle', { cx: 12, cy: 12, r: 6.5 }],
    ['circle', { cx: 12, cy: 12, r: 10.5, opacity: 0.5 }],
  ],
  grid: [
    ['rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.2 }],
    ['rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.2 }],
    ['rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.2 }],
    ['rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.2 }],
  ],
  inbox: [
    ['path', { d: 'M4 13l2.5-8.5A2 2 0 0 1 8.4 3h7.2a2 2 0 0 1 1.9 1.5L20 13' }],
    ['path', { d: 'M4 13h4l1.5 3h5l1.5-3h4v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z' }],
  ],
  mic: [
    ['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }],
    ['path', { d: 'M6 11a6 6 0 0 0 12 0' }],
    ['line', { x1: 12, y1: 17, x2: 12, y2: 21 }],
  ],
  recording: [['circle', { cx: 12, cy: 12, r: 6, ...FILL }]],
  volume: [
    ['path', { d: 'M4 9v6h4l5 4V5L8 9z' }],
    ['path', { d: 'M16 8.5a4 4 0 0 1 0 7' }],
    ['path', { d: 'M18.5 6a7 7 0 0 1 0 12', opacity: 0.6 }],
  ],
  captions: [
    ['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }],
    ['path', { d: 'M7.5 11.5a2 2 0 1 0 0 1' }],
    ['path', { d: 'M13.5 11.5a2 2 0 1 0 0 1' }],
  ],
  mute: [
    ['path', { d: 'M4 9v6h4l5 4V5L8 9z' }],
    ['line', { x1: 16, y1: 9, x2: 21, y2: 14 }],
    ['line', { x1: 21, y1: 9, x2: 16, y2: 14 }],
  ],
  megaphone: [
    ['path', { d: 'M3 11v2a1 1 0 0 0 1 1h2l9 5V5L6 10H4a1 1 0 0 0-1 1z' }],
    ['path', { d: 'M18 9a3 3 0 0 1 0 6' }],
  ],
  alert: [
    ['path', { d: 'M12 3.5 21 19a1 1 0 0 1-.9 1.5H3.9A1 1 0 0 1 3 19z' }],
    ['line', { x1: 12, y1: 9, x2: 12, y2: 14 }],
    ['circle', { cx: 12, cy: 17, r: 0.6, ...FILL }],
  ],
  close: [
    ['line', { x1: 5, y1: 5, x2: 19, y2: 19 }],
    ['line', { x1: 19, y1: 5, x2: 5, y2: 19 }],
  ],
  terminal: [
    ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }],
    ['path', { d: 'M7.5 9.5 10.5 12l-3 2.5' }],
    ['line', { x1: 12.5, y1: 15, x2: 16.5, y2: 15 }],
  ],
  hand: [
    [
      'path',
      {
        d: 'M8 13V6.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V12m0-1a1.5 1.5 0 0 1 3 0v4a5 5 0 0 1-5 5h-1a5 5 0 0 1-4-2l-2.2-3a1.4 1.4 0 0 1 2.2-1.7L8 14',
      },
    ],
  ],
  play: [['path', { d: 'M8 5.5 18 12 8 18.5z', ...FILL }]],
  pause: [
    ['rect', { x: 7, y: 6, width: 3.2, height: 12, rx: 1, ...FILL }],
    ['rect', { x: 13.8, y: 6, width: 3.2, height: 12, rx: 1, ...FILL }],
  ],
  stop: [['rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2, ...FILL }]],
  caret: [['path', { d: 'M9 6l6 6-6 6' }]],
  message: [['path', { d: 'M21 11.5a8 8 0 0 1-8 8H6l-3 3v-11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z' }]],
  globe: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M3 12h18' }],
    ['path', { d: 'M12 3a13.5 13.5 0 0 1 0 18a13.5 13.5 0 0 1 0-18' }],
  ],
  info: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['line', { x1: 12, y1: 11, x2: 12, y2: 16 }],
    ['circle', { cx: 12, cy: 7.5, r: 0.6, ...FILL }],
  ],
  refresh: [
    ['path', { d: 'M20 12a8 8 0 1 1-2.3-5.6' }],
    ['path', { d: 'M20 3v4.5h-4.5' }],
  ],
  external: [
    ['path', { d: 'M14 4h6v6' }],
    ['path', { d: 'M20 4 11 13' }],
    ['path', { d: 'M19 14v5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5' }],
  ],

  // ---- added for the renderer tracks (Lucide-style stroke) ----
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 6.5' }]],
  file: [
    ['path', { d: 'M6 2.5h7l5 5V21a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z' }],
    ['path', { d: 'M13 2.5V8h5' }],
  ],
  edit: [
    ['path', { d: 'M4 20h4l10-10-4-4L4 16v4z' }],
    ['line', { x1: 13.5, y1: 6.5, x2: 17.5, y2: 10.5 }],
  ],
  search: [
    ['circle', { cx: 11, cy: 11, r: 6.5 }],
    ['line', { x1: 16, y1: 16, x2: 21, y2: 21 }],
  ],
  folder: [
    [
      'path',
      { d: 'M3 7.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
    ],
  ],
  list: [
    ['line', { x1: 8, y1: 7, x2: 20, y2: 7 }],
    ['line', { x1: 8, y1: 12, x2: 20, y2: 12 }],
    ['line', { x1: 8, y1: 17, x2: 20, y2: 17 }],
    ['circle', { cx: 4, cy: 7, r: 0.9, ...FILL }],
    ['circle', { cx: 4, cy: 12, r: 0.9, ...FILL }],
    ['circle', { cx: 4, cy: 17, r: 0.9, ...FILL }],
  ],
  question: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M9.2 9.4a2.8 2.8 0 0 1 5.4 1c0 1.8-2.6 2.2-2.6 4' }],
    ['circle', { cx: 12, cy: 17, r: 0.6, ...FILL }],
  ],
  clipboard: [
    ['rect', { x: 5, y: 4, width: 14, height: 17, rx: 2 }],
    ['rect', { x: 9, y: 2.5, width: 6, height: 3.5, rx: 1 }],
    ['line', { x1: 8.5, y1: 11, x2: 15.5, y2: 11 }],
    ['line', { x1: 8.5, y1: 15, x2: 13.5, y2: 15 }],
  ],
  robot: [
    ['rect', { x: 4, y: 8, width: 16, height: 11, rx: 2.5 }],
    ['line', { x1: 12, y1: 4, x2: 12, y2: 8 }],
    ['circle', { cx: 12, cy: 3.5, r: 1.2, ...FILL }],
    ['circle', { cx: 9, cy: 13.5, r: 1, ...FILL }],
    ['circle', { cx: 15, cy: 13.5, r: 1, ...FILL }],
  ],
  chevronDown: [['path', { d: 'M6 9l6 6 6-6' }]],
  dot: [['circle', { cx: 12, cy: 12, r: 4, ...FILL }]],
} as const;

export type IconName = keyof typeof ICONS;

interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

/**
 * `createElement` with a string tag is typed for HTML elements; SVG child
 * attributes (cx, rx, d, …) are not on that type. Since the spec is fully
 * static and trusted, use a narrow local cast to build the SVG child nodes.
 */
const createSvgPart = createElement as unknown as (
  tag: string,
  props: Record<string, unknown>,
) => ReactElement;

export function Icon({ name, size = 16, strokeWidth = 1.6, className }: IconProps): ReactElement {
  const parts = ICONS[name].map(([tag, attrs], index) =>
    createSvgPart(tag, { key: index, ...attrs }),
  );
  return (
    <svg
      className={className ? `tn-icon ${className}` : 'tn-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {parts}
    </svg>
  );
}
