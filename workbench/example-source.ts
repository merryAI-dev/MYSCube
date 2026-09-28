import type { ReactSource } from './react-workspace-editor';

export function isReactStarterExample(source: ReactSource, example: string | undefined): boolean {
  if (!example) return false;
  if ('code' in source) return source.code === example;
  const { entry, files } = source.workspace;
  return entry === 'App.tsx' && Object.keys(files).length === 1 && files['App.tsx'] === example;
}

export function isHtmlStarterExample(html: string, example: string): boolean {
  return example.length > 0 && html === example;
}
