import { createHash } from 'node:crypto';
import { REACT_BUILD_DEPENDENCIES, REACT_TYPE_DEPENDENCIES, normalizeReactSource, canonicalWorkspace, reactSourceIdentity } from '../../shared/workbench-react-workspace.mjs';

export const fixtureHash = (value) => createHash('sha256').update(value).digest('hex');
export const fixtureSource = () => normalizeReactSource({ title: '합성 계약 검사', code: 'export default function App(){return <h1>계약 확인</h1>}' });
export function fixtureArtifact(source = fixtureSource()) {
  const bundle = 'synthetic-structural-fixture-not-executable', css = 'body { color: black; }';
  return { schemaVersion: 1, bundle, css, sourceHash: fixtureHash(reactSourceIdentity(source)), workspaceHash: fixtureHash(canonicalWorkspace(normalizeReactSource(source).workspace)),
    bundleHash: fixtureHash(bundle), cssHash: fixtureHash(css), runtimeVersion: 'react-preview-v1', packageSetHash: 'a'.repeat(64), dependencies: structuredClone(REACT_BUILD_DEPENDENCIES),
    typecheck: { status: 'passed', typescriptVersion: '5.9.3', dependencies: structuredClone(REACT_TYPE_DEPENDENCIES), declarationHash: 'b'.repeat(64) } };
}
export function fixtureRevision() {
  const source = fixtureSource(), artifact = fixtureArtifact(source);
  return { schemaVersion: 1, id: '80131892-c46e-43bc-b2ee-2d1422b3d19e', version: 1, source, sourceHash: artifact.sourceHash, artifact, apis: [], updatedAt: '2026-09-24T09:00:00.000Z', updatedBy: 'synthetic-author', restoredFrom: null };
}
