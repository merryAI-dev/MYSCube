import { createHttpError } from '../bff/bff-utils.mjs';
import { resolveHtmlBindings } from './html-bindings.mjs';

export function createHtmlDataPolicy({ analytics, authorize }) {
  return async (context, binding, source) => {
    if (!binding) return null;
    await authorize(context);
    if (binding.scopeFingerprint && binding.scopeFingerprint !== context.analyticsScope.fingerprint) throw createHttpError(403, '조회 권한이 변경되어 이 화면의 자료를 열 수 없습니다. 현재 권한으로 다시 조회해 주세요.', 'html_data_scope_changed');
    const ids = [...new Set(Object.values(binding.bindings).map((item) => item.evidenceId))];
    if (ids.length > 6) throw createHttpError(400, '화면에 연결된 근거가 너무 많습니다.', 'html_binding_invalid');
    const evidence = await Promise.all(ids.map((id) => analytics.evidence(context, id)));
    let resolved;
    try { resolved = resolveHtmlBindings({ ...binding.template, bindings: binding.bindings }, evidence); }
    catch { throw createHttpError(400, '조회 결과와 화면의 자료 연결을 확인하지 못했습니다.', 'html_binding_invalid'); }
    if (resolved.source.title !== source.title || resolved.source.html !== source.html) throw createHttpError(409, '근거를 연결한 뒤 화면의 내용이 변경되었습니다. 자료를 다시 연결하거나 직접 편집한 화면으로 저장해 주세요.', 'html_binding_changed');
    await authorize(context);
    return { template: resolved.template, bindings: resolved.bindings, evidenceIds: resolved.evidenceIds, scopeFingerprint: context.analyticsScope.fingerprint };
  };
}
