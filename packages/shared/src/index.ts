/** Metadata shared by every Terminull package. */
export interface TerminullMeta {
  /** Fully-qualified package name, e.g. "@terminull/shared". */
  readonly name: string;
  /** Package version string. */
  readonly version: string;
}

/** Typed placeholder export proving the package builds and is importable. */
export const SHARED_PLACEHOLDER: TerminullMeta = {
  name: '@terminull/shared',
  version: '0.0.0',
};
