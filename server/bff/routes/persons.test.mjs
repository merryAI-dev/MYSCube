import { describe, expect, it } from 'vitest';
import { applyEmploymentChange } from './persons.mjs';
import {
  addEmployment,
  changeEmployment,
} from '../../../src/app/platform/person-employment.ts';

/**
 * BFF 는 .mjs 라 도메인 모듈(.ts)을 런타임에 못 읽어서 전환 규칙이 양쪽에 한 번씩 있다.
 * 이 파일이 그 둘을 같은 입력으로 돌려 결과가 같은지 붙잡는다. 한쪽만 고치면 여기서 깨진다.
 */

const 노성진 = [{
  id: 'emp-ft', type: 'FULL_TIME', state: 'WORKING',
  startDate: '2022-03-02', endDate: null, note: '',
}];

function asPerson(employments) {
  return {
    personId: 'psn-nosj', name: '노성진', nickname: '', email: '',
    departmentTop: '', departmentMid: '', departmentSub: '',
    title: '', grade: '', workLocation: '', joinedAt: '2022-03-02',
    uid: null, employments,
  };
}

const containsProfileScore = value => value === '920' || value === 920
  || Boolean(value && typeof value === 'object' && Object.values(value).some(containsProfileScore));

describe('applyEmploymentChange — 계약 변경', () => {
  it('기존 계약을 적용일 직전에 닫고 새 계약을 잇는다', () => {
    const next = applyEmploymentChange(노성진, {
      mode: 'change', id: 'emp-partner', type: 'PARTNER', state: 'WORKING',
      effectiveFrom: '2026-01-01', note: '퇴사 후 파트너 전환',
    });
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ id: 'emp-ft', endDate: '2025-12-31' });
    expect(next[1]).toMatchObject({ id: 'emp-partner', type: 'PARTNER', startDate: '2026-01-01', endDate: null });
  });

  it('적용일보다 늦게 시작하는 계약이 있으면 400 과 안내를 준다', () => {
    const future = [{ id: 'f', type: 'FULL_TIME', state: 'WORKING', startDate: '2027-01-01', endDate: null, note: '' }];
    expect(() => applyEmploymentChange(future, {
      mode: 'change', id: 'x', type: 'PARTNER', state: 'WORKING', effectiveFrom: '2026-01-01',
    })).toThrow(/이미 있습니다/);
  });

  it('종료일이 적용일보다 빠르면 거절한다', () => {
    expect(() => applyEmploymentChange(노성진, {
      mode: 'change', id: 'x', type: 'PARTNER', state: 'WORKING',
      effectiveFrom: '2026-06-01', endDate: '2026-01-01',
    })).toThrow(/종료일이 적용일보다 빠릅니다/);
  });

  it('던지는 오류에 사람이 읽을 안내와 코드가 함께 붙는다', () => {
    try {
      applyEmploymentChange(노성진, {
        mode: 'change', id: 'x', type: 'PARTNER', state: 'WORKING',
        effectiveFrom: '2026-06-01', endDate: '2026-01-01',
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('person_employment_change_invalid');
      expect(error.message).not.toMatch(/[a-z_]+_[a-z_]+/);
    }
  });
});

describe('applyEmploymentChange — 계약 추가', () => {
  const 종료된계약 = [{
    id: 'a', type: 'FULL_TIME', state: 'WORKING',
    startDate: '2020-01-01', endDate: '2024-12-31', note: '',
  }];

  it('겹치지 않으면 시작일 순으로 끼워 넣는다', () => {
    const next = applyEmploymentChange(종료된계약, {
      mode: 'add', id: 'b', type: 'PARTNER', state: 'WORKING',
      effectiveFrom: '2026-01-01', endDate: '2026-12-31',
    });
    expect(next.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('겹치면 변경을 쓰라고 안내한다', () => {
    expect(() => applyEmploymentChange(종료된계약, {
      mode: 'add', id: 'b', type: 'PARTNER', state: 'WORKING', effectiveFrom: '2024-06-01',
    })).toThrow(/겹칩니다/);
  });
});

describe('BFF ↔ 도메인 모듈 동등성', () => {
  const cases = [
    { mode: 'change', type: 'PARTNER', state: 'WORKING', effectiveFrom: '2026-01-01', note: '파트너 전환' },
    { mode: 'change', type: 'FULL_TIME', state: 'PARENTAL_LEAVE', effectiveFrom: '2026-05-01' },
    { mode: 'change', type: 'FULL_TIME', state: 'WORKING', effectiveFrom: '2026-08-12', endDate: '2026-12-31' },
  ];

  it.each(cases)('change $type/$state $effectiveFrom 결과가 같다', (input) => {
    const fromBff = applyEmploymentChange(노성진, { ...input, id: 'fixed-id' });
    const fromDomain = changeEmployment(asPerson(노성진), { ...input, id: 'fixed-id' });
    expect(fromBff).toEqual(fromDomain);
  });

  it('add 결과도 같다', () => {
    const closed = [{ id: 'a', type: 'FULL_TIME', state: 'WORKING', startDate: '2020-01-01', endDate: '2024-12-31', note: '' }];
    const input = { type: 'PARTNER', state: 'WORKING', effectiveFrom: '2026-01-01', endDate: '2026-12-31', id: 'fixed-id' };
    expect(applyEmploymentChange(closed, { ...input, mode: 'add' }))
      .toEqual(addEmployment(asPerson(closed), input));
  });

  it('두 구현이 같은 입력에서 같은 이유로 거절한다', () => {
    const input = { type: 'PARTNER', state: 'WORKING', effectiveFrom: '2026-06-01', endDate: '2026-01-01', id: 'x' };
    const bffError = (() => { try { applyEmploymentChange(노성진, { ...input, mode: 'change' }); return null; } catch (error) { return error.message; } })();
    const domainError = (() => { try { changeEmployment(asPerson(노성진), input); return null; } catch (error) { return error.message; } })();
    expect(bffError).toBe(domainError);
    expect(bffError).toBeTruthy();
  });
});

// ── 라우트 레벨 ──
// 순수 함수만 테스트하면 마운트가 깨져도 초록불이 뜬다. 실제로 응답이 나오는지,
// 권한이 걸리는지, 계약 이력이 지워지지 않는지를 여기서 붙잡는다.

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { createIdempotencyService } = await import('../idempotency.mjs');
const { loadRbacPolicy } = await import('../rbac-policy.mjs');
const { mountPersonRoutes } = await import('./persons.mjs');

function profilePolicy({ read = ['admin', 'finance'], write = ['admin', 'finance'] } = {}) {
  const roles = Array.from(new Set([...read, ...write, 'admin', 'finance', 'pm', 'viewer']));
  return {
    roles,
    permissions: ['person:professional_profile:read', 'person:professional_profile:write'],
    rolePermissions: Object.fromEntries(roles.map((role) => [role, [
      ...(read.includes(role) ? ['person:professional_profile:read'] : []),
      ...(write.includes(role) ? ['person:professional_profile:write'] : []),
    ]])),
  };
}

function createApp({
  role = 'admin',
  documents = {},
  rbacPolicy = loadRbacPolicy(),
  auditManyFailure = false,
  completionFailure = false,
} = {}) {
  const app = express();
  const actor = {
    actorId: 'actor-a', actorRole: role, actorEmail: 'a@example.com', requestId: 'req-1',
  };
  let shouldFailCompletion = completionFailure;
  app.use(express.json());
  app.use((req, _res, next) => {
    req.context = {
      tenantId: 'tenant-a', ...actor,
      idempotencyKey: req.header('idempotency-key') || `key-${Math.random()}`,
    };
    next();
  });

  const store = structuredClone(documents);
  const audit = [];
  const auditHead = { lastSeq: 0 };
  const idempotencyBodies = [];
  const idempotencyRecords = new Map();
  const collectionDocs = (prefix) => Object.entries(store)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, data]) => ({ id: path.slice(prefix.length), exists: true, data: () => data }));
  const snapshot = (path) => ({
    exists: Object.hasOwn(store, path),
    data: () => store[path],
  });
  const applyWrite = ({ path, value, merge }) => {
    store[path] = merge
      ? { ...(store[path] || {}), ...structuredClone(value) }
      : structuredClone(value);
    if (path.includes('/idempotency_keys/')) {
      idempotencyRecords.set(path, structuredClone(store[path]));
      if (Object.hasOwn(value, 'responseBody')) {
        idempotencyBodies.push(structuredClone(value.responseBody));
      }
    }
  };

  const db = {
    collection: (path) => {
      const state = { filters: [], limit: Infinity };
      const query = {
        where(field, op, value) {
          if (op !== '==') throw new Error('mock collection only supports ==');
          state.filters.push([field, value]);
          return query;
        },
        limit(count) { state.limit = count; return query; },
        get: async () => ({
          docs: collectionDocs(`${path}/`)
            .filter((doc) => state.filters.every(([field, value]) => (doc.data() || {})[field] === value))
            .slice(0, state.limit),
        }),
      };
      return query;
    },
    doc: (path) => ({
      __path: path,
      path,
      get: async () => snapshot(path),
      set: async (value, options) => applyWrite({
        path,
        value,
        merge: options?.merge === true,
      }),
    }),
    runTransaction: async (fn) => {
      const writes = [];
      const pendingAudit = [];
      const result = await fn({
        get: async (ref) => snapshot(ref.__path),
        set: (ref, value, options) => {
          writes.push({ path: ref.__path, value: structuredClone(value), merge: options?.merge === true });
        },
        update: (ref, value) => {
          writes.push({ path: ref.__path, value: structuredClone(value), merge: true });
        },
        __appendAudit: (entries) => pendingAudit.push(...structuredClone(entries)),
      });
      writes.forEach(applyWrite);
      audit.push(...pendingAudit);
      auditHead.lastSeq += pendingAudit.length;
      return result;
    },
  };

  const productionIdempotencyService = createIdempotencyService(db, {
    now: () => new Date('2026-08-12T00:00:00.000Z'),
  });
  const idempotencyService = {
    ...productionIdempotencyService,
    complete: async (input) => {
      if (shouldFailCompletion) throw new Error('idempotency completion unavailable');
      return productionIdempotencyService.complete(input);
    },
    completeInTransaction: (tx, input) => {
      if (shouldFailCompletion) throw new Error('idempotency completion unavailable');
      return productionIdempotencyService.completeInTransaction(tx, input);
    },
  };

  mountPersonRoutes(app, {
    db,
    now: () => '2026-08-12T00:00:00.000Z',
    idempotencyService,
    auditChainService: {
      append: async (entry) => { audit.push(entry); },
      appendManyInTransaction: async (tx, entries) => {
        if (auditManyFailure) throw new Error('audit unavailable');
        tx.__appendAudit(entries);
      },
    },
    piiProtector: { encryptText: async (text) => ({ ciphertext: `enc:${text}` }) },
    rbacPolicy,
  });
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code, message: error.message }));
  return {
    app,
    store,
    audit,
    auditHead,
    idempotencyBodies,
    idempotencyRecords,
    setActor(patch) { Object.assign(actor, patch); },
    setCompletionFailure(value) { shouldFailCompletion = value; },
  };
}

const 노성진Doc = {
  personId: 'psn-nosj', name: '노성진', nickname: '', email: '',
  joinedAt: '2022-03-02',
  employments: [{ id: 'emp-ft', type: 'FULL_TIME', state: 'WORKING', startDate: '2022-03-02', endDate: null, note: '' }],
};

function personWithProfessionalProfile(name = '강에나') {
  return {
    name,
    nickname: '하에나',
    email: 'profile-person@example.com',
    employment: { type: 'PARTNER', state: 'WORKING', effectiveFrom: '2026-07-01' },
    professionalProfile: {
      educationRecords: [{
        attainmentCode: 'MASTER_GRADUATED',
        institutionName: 'University of Sussex',
        countryCode: 'GB',
        major: 'Development Studies',
      }],
      englishEvidence: [{
        testCode: 'TOEIC', scaleCode: 'TOEIC_990', resultValue: '920', testedAt: '2026-06',
      }],
      certifications: [{ label: 'PMP' }],
    },
  };
}

describe('라우트 — 인력 명부', () => {
  it('목록을 이름순으로 돌려준다', async () => {
    const { app } = createApp({ documents: {
      'orgs/tenant-a/persons/psn-b': { name: '홍길동', employments: [] },
      'orgs/tenant-a/persons/psn-a': { name: '강감찬', employments: [] },
    } });
    const response = await request(app).get('/api/v1/persons');
    expect(response.status).toBe(200);
    expect(response.body.items.map((item) => item.name)).toEqual(['강감찬', '홍길동']);
  });

  it('내 인사정보는 uid 로 자기 것만 찾고, 명부에 없으면 왜 비었는지 알린다', async () => {
    const documents = {
      'orgs/tenant-a/persons/person-me': {
        personId: 'person-me', name: '변민욱', nickname: '보람', uid: 'actor-a',
        grade: '책임연구원', joinedAt: '2025-04-02', birthDate: '1996-12-20',
        employments: [], note: 'PERSON_NOTE_SECRET',
        professionalProfile: {
          schemaVersion: 1,
          educationRecords: [{ attainmentCode: 'MASTER_GRADUATED', institutionName: 'Sussex', countryCode: 'GB', major: '개발학', admissionYear: '2015', degreeYear: '2017', evidence: null }],
          englishEvidence: [],
          certifications: [{ key: 'pmp', label: 'PMP', acquiredAt: '2019-05', evidence: null }],
          provenance: { source: 'PEOPLE_MANUAL', revision: 1, updatedAt: '2026-08-27T00:00:00.000Z', updatedBy: 'actor-b' },
        },
      },
      'orgs/tenant-a/persons/person-other': {
        personId: 'person-other', name: '남', uid: 'actor-z', employments: [],
        professionalProfile: {
          schemaVersion: 1, educationRecords: [], englishEvidence: [],
          certifications: [{ key: 'other-secret', label: 'OTHER_SECRET', acquiredAt: null, evidence: null }],
          provenance: { source: 'PEOPLE_MANUAL', revision: 1, updatedAt: null, updatedBy: null },
        },
      },
    };

    // 권한이 낮은 역할도 자기 것은 본다 - 본인 데이터라 별도 권한을 요구하지 않는다.
    const { app } = createApp({ role: 'viewer', documents });
    const mine = await request(app).get('/api/v1/persons/me/hr-profile');
    expect(mine.status).toBe(200);
    expect(mine.body.linked).toBe(true);
    expect(mine.body.person).toMatchObject({ personId: 'person-me', grade: '책임연구원', birthDate: '1996-12-20' });
    expect(mine.body.profile.certifications).toEqual([
      { key: 'pmp', label: 'PMP', acquiredAt: '2019-05', evidence: null },
    ]);
    // 남의 인사정보도, 명부 내부 메모도 섞이지 않는다.
    expect(JSON.stringify(mine.body)).not.toContain('OTHER_SECRET');
    expect(JSON.stringify(mine.body)).not.toContain('PERSON_NOTE_SECRET');

    // uid 가 명부에 없는 계정은 빈 화면 대신 왜 비었는지 알 수 있어야 한다.
    const { app: unlinkedApp } = createApp({ role: 'viewer', documents: {} });
    const unlinked = await request(unlinkedApp).get('/api/v1/persons/me/hr-profile');
    expect(unlinked.status).toBe(200);
    expect(unlinked.body).toEqual({ linked: false, person: null, profile: null });
  });

  /**
   * 마이페이지에서 본인이 고치는 값. 대상은 경로가 아니라 로그인 계정의 uid 로 정해진다 -
   * 남의 personId 를 넣을 자리 자체가 없다.
   */
  it('본인 기본정보만 고치고, 회사가 관리하는 값은 열지 않는다', async () => {
    const documents = {
      'orgs/tenant-a/persons/person-me': {
        personId: 'person-me', name: '변민욱', nickname: '옛닉', uid: 'actor-a',
        grade: '책임연구원', departmentTop: '대표이사실', joinedAt: '2025-04-02', employments: [],
      },
      'orgs/tenant-a/persons/person-other': {
        personId: 'person-other', name: '남', nickname: '남닉', uid: 'actor-z', employments: [],
      },
    };
    const { app, store } = createApp({ role: 'viewer', documents });

    const saved = await request(app)
      .patch('/api/v1/persons/me/profile')
      .set({ 'idempotency-key': 'self-profile-1' })
      .send({ nickname: '새닉', birthDate: '1996-12-20', workLocation: '성수' });

    expect(saved.status).toBe(200);
    expect(saved.body.personId).toBe('person-me');
    expect(store['orgs/tenant-a/persons/person-me']).toMatchObject({
      nickname: '새닉', birthDate: '1996-12-20', workLocation: '성수',
    });
    // 남의 문서는 그대로다.
    expect(store['orgs/tenant-a/persons/person-other'].nickname).toBe('남닉');
    // 회사가 관리하는 값은 스키마가 막는다.
    expect(store['orgs/tenant-a/persons/person-me'].grade).toBe('책임연구원');

    const forbidden = await request(app)
      .patch('/api/v1/persons/me/profile')
      .set({ 'idempotency-key': 'self-profile-2' })
      .send({ grade: '대표이사' });
    expect(forbidden.status).toBe(400);

    const empty = await request(app)
      .patch('/api/v1/persons/me/profile')
      .set({ 'idempotency-key': 'self-profile-3' })
      .send({});
    expect(empty.status).toBe(400);
  });

  it('명부에 연결되지 않은 계정은 본인 기본정보를 고칠 수 없다', async () => {
    const { app } = createApp({ role: 'viewer', documents: {} });
    const response = await request(app)
      .patch('/api/v1/persons/me/profile')
      .set({ 'idempotency-key': 'self-profile-unlinked' })
      .send({ nickname: '아무개' });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('person_not_linked');
  });

  it('목록은 명시적 allowlist만 반환하고 전문 프로필 원문은 전역 store에 흘리지 않는다', async () => {
    const { app } = createApp({ documents: {
      'orgs/tenant-a/persons/person-a': {
        personId: 'person-a',
        name: '김정태',
        nickname: '정태',
        email: 'jt@example.com',
        departmentTop: '임팩트사업부',
        departmentMid: 'CIC',
        departmentSub: 'A센터',
        title: '매니저',
        grade: 'G3',
        workLocation: '서울',
        joinedAt: '2024-01-01',
        uid: 'uid-a',
        employments: [],
        note: '내부 메모',
        phone: '010-0000-0000',
        professionalProfile: {
          educationRecords: [{ institutionName: 'University of Sussex' }],
        },
      },
    } });
    const response = await request(app).get('/api/v1/persons');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.capabilities).toEqual({
      professionalProfileRead: true,
      professionalProfileWrite: true,
    });
    // 깨진 프로필(학력 구분 없음)이 들어 있어도 목록은 살아 있어야 한다 - 그 사람만 빈 요약이 된다.
    expect(response.body.items[0]).toEqual({
      personId: 'person-a',
      name: '김정태',
      birthDate: '',
      hrSummary: {
        highestEducationDisplayText: '',
        highestDegreeYear: '',
        highestEducationCode: '',
        highestEducationInstitution: '',
        highestEducationMajor: '',
        englishEvidenceDisplayText: '',
        certificationsDisplayText: '',
      },
      nickname: '정태',
      email: 'jt@example.com',
      departmentTop: '임팩트사업부',
      departmentMid: 'CIC',
      departmentSub: 'A센터',
      title: '매니저',
      grade: 'G3',
      workLocation: '서울',
      joinedAt: '2024-01-01',
      uid: 'uid-a',
      employments: [],
    });
    expect(response.body.items[0]).not.toHaveProperty('professionalProfile');
    expect(response.body.items[0]).not.toHaveProperty('note');
    expect(response.body.items[0]).not.toHaveProperty('phone');
    expect(JSON.stringify(response.body.items[0])).not.toContain('University of Sussex');
  });

  it.each([
    ['admin', true, true],
    ['finance', true, true],
    ['pm', false, false],
    ['viewer', false, false],
  ])('%s 목록 capability는 주입된 production policy를 따른다', async (role, read, write) => {
    const { app } = createApp({ role });
    const response = await request(app).get('/api/v1/persons');
    expect(response.status).toBe(200);
    expect(response.body.capabilities).toEqual({
      professionalProfileRead: read,
      professionalProfileWrite: write,
    });
  });

  it('role 이름이 아니라 주입된 policy가 목록 capability를 결정한다', async () => {
    const opposite = profilePolicy({ read: ['pm'], write: ['pm'] });
    const adminResponse = await request(createApp({ role: 'admin', rbacPolicy: opposite }).app)
      .get('/api/v1/persons');
    const pmResponse = await request(createApp({ role: 'pm', rbacPolicy: opposite }).app)
      .get('/api/v1/persons');

    expect(adminResponse.body.capabilities).toEqual({
      professionalProfileRead: false,
      professionalProfileWrite: false,
    });
    expect(pmResponse.body.capabilities).toEqual({
      professionalProfileRead: true,
      professionalProfileWrite: true,
    });
  });

  it('viewer 는 계약을 바꿀 수 없다', async () => {
    const { app } = createApp({ role: 'viewer', documents: { 'orgs/tenant-a/persons/psn-nosj': 노성진Doc } });
    const response = await request(app)
      .post('/api/v1/persons/psn-nosj/employments')
      .send({ mode: 'change', type: 'PARTNER', state: 'WORKING', effectiveFrom: '2026-01-01' });
    expect(response.status).toBe(403);
  });

  it('재경팀(finance)은 계약을 바꿀 수 있다 — 실제로 기입하는 사람이다', async () => {
    const { app } = createApp({ role: 'finance', documents: { 'orgs/tenant-a/persons/psn-nosj': 노성진Doc } });
    const response = await request(app)
      .post('/api/v1/persons/psn-nosj/employments')
      .send({ mode: 'change', type: 'PARTNER', state: 'WORKING', effectiveFrom: '2026-01-01' });
    expect(response.status).toBe(200);
  });

  it('정규직 → 파트너 전환이 이력을 지우지 않고 이어 붙는다', async () => {
    const { app, store } = createApp({ documents: { 'orgs/tenant-a/persons/psn-nosj': 노성진Doc } });
    const response = await request(app)
      .post('/api/v1/persons/psn-nosj/employments')
      .send({ mode: 'change', type: 'PARTNER', state: 'WORKING', effectiveFrom: '2026-01-01', note: '퇴사 후 파트너' });

    expect(response.status).toBe(200);
    expect(response.body.employments).toHaveLength(2);
    expect(response.body.employments[0]).toMatchObject({ id: 'emp-ft', type: 'FULL_TIME', endDate: '2025-12-31' });
    expect(response.body.employments[1]).toMatchObject({ type: 'PARTNER', startDate: '2026-01-01', endDate: null });
    expect(store['orgs/tenant-a/persons/psn-nosj'].employments).toHaveLength(2);
  });

  it('명부에 없는 사람은 404 와 한국어 안내를 준다', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/v1/persons/psn-nope/employments')
      .send({ mode: 'change', type: 'PARTNER', state: 'WORKING', effectiveFrom: '2026-01-01' });
    expect(response.status).toBe(404);
    expect(response.body.message).toContain('명부에 없는 인력입니다');
  });

  it('잘못된 날짜는 400 과 고칠 방법을 준다', async () => {
    const { app } = createApp({ documents: { 'orgs/tenant-a/persons/psn-nosj': 노성진Doc } });
    const response = await request(app)
      .post('/api/v1/persons/psn-nosj/employments')
      .send({ mode: 'change', type: 'PARTNER', state: 'WORKING', effectiveFrom: '2026/01/01' });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain('YYYY-MM-DD');
  });

  it('파트너를 새 인력으로 등록하면 첫 계약이 함께 생긴다', async () => {
    const { app, store } = createApp();
    const response = await request(app).post('/api/v1/persons').send({
      name: '강에나', nickname: '하에나',
      employment: { type: 'PARTNER', state: 'WORKING', effectiveFrom: '2026-07-01' },
    });
    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.person.employments[0]).toMatchObject({ type: 'PARTNER', startDate: '2026-07-01' });
    expect(response.body.person.source.origin).toBe('manual');
    expect(store['orgs/tenant-a/persons/psn-x-강에나하에나']).toBeTruthy();
  });

  it('점수 유출 검사에서 UUID 부분문자열은 허용하고 문자열·숫자 점수 값은 탐지한다', () => {
    expect(containsProfileScore({ employments: [{ id: '19395b94-16d6-4097-920d-d2ce147ab799' }] })).toBe(false);
    expect(containsProfileScore({ nested: [{ resultValue: '920' }] })).toBe(true);
    expect(containsProfileScore({ nested: [{ resultValue: 920 }] })).toBe(true);
  });

  it('신규 인력과 비어 있지 않은 전문 프로필을 CREATE + PROFILE_UPDATE audit과 한 transaction으로 저장한다', async () => {
    const { app, store, audit, auditHead, idempotencyBodies } = createApp();
    const response = await request(app).post('/api/v1/persons').send(personWithProfessionalProfile());

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      person: { personId: 'psn-x-강에나하에나', name: '강에나' },
      professionalProfile: { revision: 1, changed: true },
    });
    expect(response.body.professionalProfile).toEqual({ revision: 1, changed: true });
    expect(JSON.stringify(response.body)).not.toMatch(/Sussex|Development Studies|TOEIC|PMP/);
    expect(containsProfileScore(response.body)).toBe(false);
    expect(store['orgs/tenant-a/persons/psn-x-강에나하에나'].professionalProfile).toMatchObject({
      educationRecords: [expect.objectContaining({ institutionName: 'University of Sussex' })],
      certifications: [{ key: 'pmp', label: 'PMP' }],
      provenance: { revision: 1, updatedBy: 'actor-a' },
    });
    expect(audit.map(({ action }) => action)).toEqual(['CREATE', 'PROFILE_UPDATE']);
    expect(auditHead.lastSeq).toBe(2);
    expect(JSON.stringify(audit[1])).not.toMatch(/Sussex|Development Studies|TOEIC|2026-06|PMP/);
    expect(containsProfileScore(audit[1])).toBe(false);
    expect(JSON.stringify(idempotencyBodies)).not.toMatch(/Sussex|Development Studies|TOEIC|2026-06|PMP/);
    expect(containsProfileScore(idempotencyBodies)).toBe(false);
  });

  it('전문 프로필 포함 생성은 PII-free receipt만 저장하고 replay 응답은 canonical person으로 재구성한다', async () => {
    const harness = createApp();
    const payload = personWithProfessionalProfile('리플레이');
    const personPath = 'orgs/tenant-a/persons/psn-x-리플레이하에나';
    const first = await request(harness.app)
      .post('/api/v1/persons')
      .set('idempotency-key', 'pii-free-person-receipt')
      .send(payload);
    expect(first.status).toBe(201);

    harness.store[personPath].title = '선임 매니저';
    const replay = await request(harness.app)
      .post('/api/v1/persons')
      .set('idempotency-key', 'pii-free-person-receipt')
      .send(payload);

    expect(replay.status).toBe(201);
    expect(replay.headers['x-idempotency-replayed']).toBe('1');
    expect(replay.body).toMatchObject({
      person: {
        personId: 'psn-x-리플레이하에나',
        name: '리플레이',
        title: '선임 매니저',
      },
      professionalProfile: { revision: 1, changed: true },
    });
    expect(harness.idempotencyBodies).toEqual([{
      personId: 'psn-x-리플레이하에나',
      revision: 1,
      changed: true,
    }]);
    expect([...harness.idempotencyRecords.values()].map(({ responseBody }) => responseBody))
      .toEqual(harness.idempotencyBodies);
    expect(JSON.stringify([...harness.idempotencyRecords.values()]))
      .not.toMatch(/profile-person@example\.com|Sussex|Development Studies|TOEIC|2026-06|PMP/);
    expect(containsProfileScore([...harness.idempotencyRecords.values()])).toBe(false);
    expect(harness.audit.map(({ action }) => action)).toEqual(['CREATE', 'PROFILE_UPDATE']);
  });

  it('권한을 잃은 사용자는 기존 POST /persons 성공 영수증도 replay하지 못한다', async () => {
    const harness = createApp();
    const payload = {
      name: '레거시권한',
      employment: { type: 'FULL_TIME', state: 'WORKING', effectiveFrom: '2026-08-01' },
    };
    const first = await request(harness.app)
      .post('/api/v1/persons')
      .set('idempotency-key', 'legacy-permission-before-replay')
      .send(payload);
    expect(first.status).toBe(201);
    const before = structuredClone({ store: harness.store, audit: harness.audit });

    harness.setActor({ actorRole: 'viewer' });
    const replay = await request(harness.app)
      .post('/api/v1/persons')
      .set('idempotency-key', 'legacy-permission-before-replay')
      .send(payload);

    expect(replay.status).toBe(403);
    expect(replay.body.code || replay.body.error).toBe('forbidden');
    expect({ store: harness.store, audit: harness.audit }).toEqual(before);
  });

  it('권한을 잃은 사용자는 전문 프로필 포함 POST /persons 영수증도 replay하지 못한다', async () => {
    const harness = createApp();
    const payload = personWithProfessionalProfile('프로필권한');
    const first = await request(harness.app)
      .post('/api/v1/persons')
      .set('idempotency-key', 'profile-permission-before-replay')
      .send(payload);
    expect(first.status).toBe(201);
    const before = structuredClone({ store: harness.store, audit: harness.audit });

    harness.setActor({ actorRole: 'viewer' });
    const replay = await request(harness.app)
      .post('/api/v1/persons')
      .set('idempotency-key', 'profile-permission-before-replay')
      .send(payload);

    expect(replay.status).toBe(403);
    expect(replay.body.code || replay.body.error).toBe('forbidden');
    expect({ store: harness.store, audit: harness.audit }).toEqual(before);
  });

  it('다른 권한 보유자는 같은 key로 전문 프로필 포함 POST를 replay하지 못한다', async () => {
    const harness = createApp();
    const payload = personWithProfessionalProfile('액터바인딩');
    expect((await request(harness.app)
      .post('/api/v1/persons')
      .set('idempotency-key', 'actor-bound-person-create')
      .send(payload)).status).toBe(201);

    harness.setActor({ actorId: 'actor-b', requestId: 'req-2' });
    const replay = await request(harness.app)
      .post('/api/v1/persons')
      .set('idempotency-key', 'actor-bound-person-create')
      .send(payload);

    expect(replay.status).toBe(409);
    expect(replay.body.code || replay.body.error).toBe('idempotency_conflict');
    expect(replay.headers['x-idempotency-replayed']).toBeUndefined();
    expect(harness.audit.map(({ action }) => action)).toEqual(['CREATE', 'PROFILE_UPDATE']);
  });

  it('idempotency completion 실패 시 person/audit/receipt 모두 rollback하고 같은 key retry가 생성한다', async () => {
    const harness = createApp({ completionFailure: true });
    const payload = personWithProfessionalProfile('완료롤백');

    const failed = await request(harness.app)
      .post('/api/v1/persons')
      .set('idempotency-key', 'atomic-person-create-retry')
      .send(payload);

    expect(failed.status).toBe(500);
    expect(harness.store).toEqual({});
    expect(harness.audit).toEqual([]);
    expect(harness.auditHead).toEqual({ lastSeq: 0 });
    expect(harness.idempotencyRecords.size).toBe(0);

    harness.setCompletionFailure(false);
    const retried = await request(harness.app)
      .post('/api/v1/persons')
      .set('idempotency-key', 'atomic-person-create-retry')
      .send(payload);

    expect(retried.status).toBe(201);
    expect(retried.body.professionalProfile).toEqual({ revision: 1, changed: true });
    expect(retried.headers['x-idempotency-replayed']).toBeUndefined();
    expect(harness.audit.map(({ action }) => action)).toEqual(['CREATE', 'PROFILE_UPDATE']);
    expect(harness.auditHead).toEqual({ lastSeq: 2 });
    expect(harness.idempotencyRecords.size).toBe(1);
  });

  it('명시적으로 빈 전문 프로필도 profile write 권한이 없으면 생성 전에 거부한다', async () => {
    const noProfileWrite = profilePolicy({ read: [], write: [] });
    const { app, store, audit } = createApp({ role: 'finance', rbacPolicy: noProfileWrite });
    const response = await request(app).post('/api/v1/persons').send({
      name: '빈프로필',
      employment: { type: 'FULL_TIME', state: 'WORKING', effectiveFrom: '2026-08-01' },
      professionalProfile: { educationRecords: [], englishEvidence: [], certifications: [] },
    });

    expect(response.status).toBe(403);
    expect(store).toEqual({});
    expect(audit).toEqual([]);
  });

  it('권한 있는 explicit empty는 profile 미저장/revision 0으로 CREATE와 safe receipt만 atomic commit한다', async () => {
    const harness = createApp();
    const response = await request(harness.app)
      .post('/api/v1/persons')
      .set('idempotency-key', 'explicit-empty-profile')
      .send({
        name: '빈프로필',
        employment: { type: 'FULL_TIME', state: 'WORKING', effectiveFrom: '2026-08-01' },
        professionalProfile: { educationRecords: [], englishEvidence: [], certifications: [] },
      });

    expect(response.status).toBe(201);
    expect(response.body.professionalProfile).toEqual({ revision: 0, changed: false });
    expect(harness.store['orgs/tenant-a/persons/psn-x-빈프로필'])
      .not.toHaveProperty('professionalProfile');
    expect(harness.audit.map(({ action }) => action)).toEqual(['CREATE']);
    expect(harness.auditHead).toEqual({ lastSeq: 1 });
    expect(harness.idempotencyBodies).toEqual([{
      personId: 'psn-x-빈프로필',
      revision: 0,
      changed: false,
    }]);
  });

  it('explicit empty completion 실패도 person/CREATE audit/receipt를 함께 rollback하고 retry한다', async () => {
    const harness = createApp({ completionFailure: true });
    const payload = {
      name: '빈프로필롤백',
      employment: { type: 'FULL_TIME', state: 'WORKING', effectiveFrom: '2026-08-01' },
      professionalProfile: { educationRecords: [], englishEvidence: [], certifications: [] },
    };
    const first = await request(harness.app)
      .post('/api/v1/persons')
      .set('idempotency-key', 'explicit-empty-retry')
      .send(payload);

    expect(first.status).toBe(500);
    expect(harness.store).toEqual({});
    expect(harness.audit).toEqual([]);
    expect(harness.auditHead).toEqual({ lastSeq: 0 });
    expect(harness.idempotencyRecords.size).toBe(0);

    harness.setCompletionFailure(false);
    const retried = await request(harness.app)
      .post('/api/v1/persons')
      .set('idempotency-key', 'explicit-empty-retry')
      .send(payload);
    expect(retried.status).toBe(201);
    expect(retried.body.professionalProfile).toEqual({ revision: 0, changed: false });
    expect(harness.audit.map(({ action }) => action)).toEqual(['CREATE']);
    expect(harness.auditHead).toEqual({ lastSeq: 1 });
    expect(harness.idempotencyRecords.size).toBe(1);
  });

  it('professionalProfile을 생략한 legacy create는 profile write 권한 없이 기존 경로를 유지한다', async () => {
    const noProfileWrite = profilePolicy({ read: [], write: [] });
    const harness = createApp({ role: 'finance', rbacPolicy: noProfileWrite });
    const response = await request(harness.app).post('/api/v1/persons').send({
      name: '프로필생략',
      employment: { type: 'FULL_TIME', state: 'WORKING', effectiveFrom: '2026-08-01' },
    });

    expect(response.status).toBe(201);
    expect(response.body).not.toHaveProperty('professionalProfile');
    expect(harness.store['orgs/tenant-a/persons/psn-x-프로필생략'])
      .not.toHaveProperty('professionalProfile');
    expect(harness.audit.map(({ action }) => action)).toEqual(['CREATE']);
  });

  it('비어 있지 않은 전문 프로필 생성은 기본 create와 profile write 권한을 모두 요구한다', async () => {
    const noProfileWrite = profilePolicy({ read: ['admin', 'finance'], write: [] });
    const { app, store, audit } = createApp({ role: 'finance', rbacPolicy: noProfileWrite });
    const response = await request(app).post('/api/v1/persons').send({
      name: '권한없음',
      employment: { type: 'FULL_TIME', state: 'WORKING', effectiveFrom: '2026-08-01' },
      professionalProfile: {
        educationRecords: [{ attainmentCode: 'BACHELOR_GRADUATED' }],
        englishEvidence: [],
        certifications: [],
      },
    });

    expect(response.status).toBe(403);
    expect(store).toEqual({});
    expect(audit).toEqual([]);
  });

  it('profile write permission만 있어도 기본 person create 권한이 없으면 생성하지 않는다', async () => {
    const profileWriter = profilePolicy({ read: ['pm'], write: ['pm'] });
    const { app, store, audit } = createApp({ role: 'pm', rbacPolicy: profileWriter });
    const response = await request(app).post('/api/v1/persons').send({
      name: '기본권한없음',
      employment: { type: 'FULL_TIME', state: 'WORKING', effectiveFrom: '2026-08-01' },
      professionalProfile: {
        educationRecords: [{ attainmentCode: 'BACHELOR_GRADUATED' }],
        englishEvidence: [],
        certifications: [],
      },
    });

    expect(response.status).toBe(403);
    expect(store).toEqual({});
    expect(audit).toEqual([]);
  });

  it('전문 프로필 포함 생성은 audit 실패 시 person까지 rollback한다', async () => {
    const { app, store, audit, auditHead } = createApp({ auditManyFailure: true });
    const response = await request(app).post('/api/v1/persons').send({
      name: '롤백대상',
      employment: { type: 'FULL_TIME', state: 'WORKING', effectiveFrom: '2026-08-01' },
      professionalProfile: {
        educationRecords: [{ attainmentCode: 'BACHELOR_GRADUATED' }],
        englishEvidence: [],
        certifications: [],
      },
    });

    expect(response.status).toBe(500);
    expect(store).toEqual({});
    expect(audit).toEqual([]);
    expect(auditHead.lastSeq).toBe(0);
  });

  it('같은 사람을 두 번 등록하면 409 로 막는다 — 명부가 갈라지면 안 된다', async () => {
    const { app } = createApp({ documents: { 'orgs/tenant-a/persons/psn-x-강에나하에나': { name: '강에나' } } });
    const response = await request(app).post('/api/v1/persons').send({
      name: '강에나', nickname: '하에나',
      employment: { type: 'PARTNER', state: 'WORKING', effectiveFrom: '2026-07-01' },
    });
    expect(response.status).toBe(409);
  });

  it('알 수 없는 근로형태는 스키마에서 걸린다', async () => {
    const { app } = createApp({ documents: { 'orgs/tenant-a/persons/psn-nosj': 노성진Doc } });
    const response = await request(app)
      .post('/api/v1/persons/psn-nosj/employments')
      .send({ mode: 'change', type: 'CONTRACTOR', state: 'WORKING', effectiveFrom: '2026-01-01' });
    expect(response.status).toBe(400);
  });
});
