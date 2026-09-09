import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import type {
  Project,
  Ledger,
  Transaction,
  Comment,
  Evidence,
  AuditLog,
  LedgerTemplate,
  OrgMember,
  Organization,
  TransactionState,
  ParticipationEntry,
} from './types';
import {
  ORGANIZATION,
  ORG_MEMBERS,
  CURRENT_USER,
  PROJECTS,
  LEDGERS,
  TRANSACTIONS,
  COMMENTS,
  EVIDENCES,
  AUDIT_LOGS,
  LEDGER_TEMPLATES,
} from './mock-data';
import { buildPersonDirectory, type DirectoryPerson, type PersonDirectory } from '../platform/person-directory';
import { resolveEmploymentTypeAt } from '../platform/person-employment';
import { mergeProjectMutationResult } from './project-store-mutation';
import { resolveAppWriteStrategy } from './store-write-strategy';
import { useFirebase } from '../lib/firebase-context';
import { featureFlags } from '../config/feature-flags';
import { useAuth } from './auth-store';
import {
  readOrgCollection,
  addPartEntry,
  updatePartEntry,
  deletePartEntry,
  upsertProject,
  upsertLedger,
  upsertTransaction,
  changeTransactionStateFS,
  addCommentFS,
  addEvidenceFS,
  upsertMember as upsertMemberFS,
  deleteMember as deleteMemberFS,
} from '../lib/firestore-service';
import {
  addCommentViaBff,
  addEvidenceViaBff,
  changeTransactionStateViaBff,
  fetchProjectsViaBff,
  restoreProjectViaBff,
  trashProjectViaBff,
  upsertLedgerViaBff,
  upsertProjectViaBff,
  upsertTransactionViaBff,
  type UpsertProjectPayload,
  fetchPersonsViaBff,
  type PersonRecord,
} from '../lib/platform-bff-client';
import { reportError } from '../platform/observability';
import { normalizeProjectRevenueFields } from '../platform/project-financials';
import { regularizeProjectOwnerNames } from './project-team-member-options';

interface EtlStagingUiPayload {
  projects?: Project[];
  members?: OrgMember[];
  ledgers?: Ledger[];
  transactions?: Transaction[];
  comments?: Comment[];
  evidences?: Evidence[];
  auditLogs?: AuditLog[];
  participationEntries?: ParticipationEntry[];
}

interface AppState {
  org: Organization;
  currentUser: OrgMember;
  members: OrgMember[];
  templates: LedgerTemplate[];
  projects: Project[];
  allProjects: Project[];
  ledgers: Ledger[];
  transactions: Transaction[];
  comments: Comment[];
  evidences: Evidence[];
  auditLogs: AuditLog[];
  participationEntries: ParticipationEntry[];
  persons: PersonRecord[];
  /** 사람 고르는 자리들이 쓰는 형태. 근로형태가 오늘 기준으로 채워져 있다. */
  personRoster: DirectoryPerson[];
  personDirectory: PersonDirectory;
  dataSource: 'local' | 'firestore';
}

interface AppActions {
  upsertMember: (member: OrgMember & Record<string, unknown>) => Promise<void>;
  removeMember: (uid: string) => Promise<void>;
  addProject: (p: Project) => Promise<void>;
  updateProject: (id: string, updates: Partial<Project>) => Promise<void>;
  patchProjectSnapshot: (project: Project) => void;
  trashProject: (id: string, reason?: string) => Promise<void>;
  restoreProject: (id: string) => Promise<void>;
  addLedger: (l: Ledger) => Promise<void>;
  addTransaction: (t: Transaction) => Promise<void>;
  updateTransaction: (id: string, updates: Partial<Transaction>) => Promise<void>;
  changeTransactionState: (id: string, newState: TransactionState, reason?: string) => Promise<void>;
  addComment: (c: Comment) => Promise<void>;
  addEvidence: (e: Evidence) => Promise<void>;
  addParticipation: (pe: ParticipationEntry) => Promise<void>;
  updateParticipation: (id: string, updates: Partial<ParticipationEntry>) => Promise<void>;
  removeParticipation: (id: string) => Promise<void>;
  getProjectLedgers: (projectId: string) => Ledger[];
  getLedgerTransactions: (ledgerId: string) => Transaction[];
  getTransactionComments: (txId: string) => Comment[];
  getTransactionEvidences: (txId: string) => Evidence[];
  getProjectById: (id: string) => Project | undefined;
  getLedgerById: (id: string) => Ledger | undefined;
}

const _g = globalThis as any;
if (!_g.__MYSC_APP_CTX__) {
  _g.__MYSC_APP_CTX__ = createContext<(AppState & AppActions) | null>(null);
}
const AppContext: React.Context<(AppState & AppActions) | null> = _g.__MYSC_APP_CTX__;

function upsertLocalItem<T extends { id: string }>(items: T[], item: T): T[] {
  const existingIndex = items.findIndex((existing) => existing.id === item.id);
  if (existingIndex === -1) return [...items, item];
  const next = [...items];
  next[existingIndex] = { ...next[existingIndex], ...item };
  return next;
}

function updateLocalItem<T extends { id: string }>(items: T[], id: string, updates: Partial<T>): T[] {
  return items.map((item) => (item.id === id ? { ...item, ...updates } : item));
}

function buildTransactionStateLocalPatch(
  newState: TransactionState,
  actorId: string,
  reason?: string,
): Partial<Transaction> {
  const updates: Partial<Transaction> = { state: newState };
  if (newState === 'SUBMITTED') {
    updates.submittedBy = actorId;
    updates.submittedAt = new Date().toISOString();
  } else if (newState === 'APPROVED') {
    updates.approvedBy = actorId;
    updates.approvedAt = new Date().toISOString();
  } else if (newState === 'REJECTED') {
    updates.rejectedReason = reason || '';
  }
  return updates;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { db, isOnline, orgId } = useFirebase();
  const { user: authUser } = useAuth();

  const firestoreEnabled = featureFlags.firestoreCoreEnabled && isOnline && !!db;
  const platformApiEnabled = featureFlags.platformApiEnabled;
  const writeStrategy = useMemo(
    () => resolveAppWriteStrategy(platformApiEnabled, firestoreEnabled),
    [platformApiEnabled, firestoreEnabled],
  );

  const usesLocalSeedData = !platformApiEnabled && !featureFlags.firestoreCoreEnabled;
  const [projects, setProjects] = useState<Project[]>(() => (usesLocalSeedData ? PROJECTS : []));
  const [ledgers, setLedgers] = useState<Ledger[]>(() => (usesLocalSeedData ? LEDGERS : []));
  const [transactions, setTransactions] = useState<Transaction[]>(() => (usesLocalSeedData ? TRANSACTIONS : []));
  const [comments, setComments] = useState<Comment[]>(() => (usesLocalSeedData ? COMMENTS : []));
  const [evidences, setEvidences] = useState<Evidence[]>(() => (usesLocalSeedData ? EVIDENCES : []));
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>(() => (usesLocalSeedData ? AUDIT_LOGS : []));
  const [participationEntries, setParticipationEntries] = useState<ParticipationEntry[]>([]);
  const [localMembers, setLocalMembers] = useState<Array<OrgMember & Record<string, unknown>>>(
    ORG_MEMBERS as Array<OrgMember & Record<string, unknown>>,
  );
  const [dataSource, setDataSource] = useState<'local' | 'firestore'>('local');
  const [persons, setPersons] = useState<PersonRecord[]>([]);

  const currentUser = useMemo<OrgMember>(() => {
    if (!authUser) return CURRENT_USER;
    return {
      uid: authUser.uid,
      name: authUser.name,
      email: authUser.email,
      role: authUser.role,
      avatarUrl: authUser.avatarUrl,
    };
  }, [authUser]);

  const auditActor = useMemo(
    () => ({ id: currentUser.uid, name: currentUser.name, role: currentUser.role }),
    [currentUser.uid, currentUser.name, currentUser.role],
  );

  const bffActor = useMemo(
    () => ({
      uid: currentUser.uid,
      email: currentUser.email,
      role: currentUser.role,
      idToken: authUser?.idToken,
    }),
    [currentUser.uid, currentUser.email, currentUser.role, authUser?.idToken],
  );

  const reportWriteFailure = useCallback((operation: string, error: unknown) => {
    reportError(error, {
      message: `[AppStore] ${operation} failed:`,
      options: {
        level: 'error',
        tags: {
          surface: 'app_store',
          action: operation,
          writeTarget: writeStrategy.target,
        },
        extra: {
          orgId,
          actorId: currentUser.uid,
          actorRole: currentUser.role,
          platformApiEnabled,
          firestoreEnabled,
          dataSource,
        },
      },
    });
  }, [
    currentUser.role,
    currentUser.uid,
    dataSource,
    firestoreEnabled,
    orgId,
    platformApiEnabled,
    writeStrategy.target,
  ]);

  const runStoreMutation = useCallback(async function runStoreMutation<T>(
    operation: string,
    perform: () => Promise<T>,
  ): Promise<T> {
    try {
      return await perform();
    } catch (error) {
      reportWriteFailure(operation, error);
      throw error;
    }
  }, [reportWriteFailure]);

  // 인력 명부. 이름으로 동일인을 찾을 때의 근거가 되고, 못 불러와도 화면은 계속 뜬다 -
  // 명부가 비면 이름 기반 대체 키로 떨어질 뿐 참여율 화면이 막히지는 않는다.
  useEffect(() => {
    if (!platformApiEnabled || !bffActor.idToken) {
      setPersons([]);
      return undefined;
    }
    let cancelled = false;
    fetchPersonsViaBff({ tenantId: orgId, actor: bffActor })
      .then((response) => {
        if (!cancelled) setPersons(response.items || []);
      })
      .catch((error) => {
        reportError(error, {
          message: '[AppStore] persons fetch failed; name matching falls back to display names:',
          options: {
            level: 'warning',
            tags: { surface: 'app_store', action: 'persons_fetch' },
            extra: { orgId },
          },
        });
      });
    return () => { cancelled = true; };
  }, [orgId, platformApiEnabled, bffActor]);

  // 명부를 사람 고르는 자리들이 쓰는 형태로 한 번만 변환한다. 근로형태는 오늘 기준으로
  // 파생시킨다 - 문서에 저장하면 계약이 끝나도 값이 그대로 남는다.
  const personRoster = useMemo<DirectoryPerson[]>(() => persons.map((person) => ({
    personId: person.personId,
    name: person.name,
    nickname: person.nickname || '',
    employmentType: resolveEmploymentTypeAt(person.employments, new Date().toISOString().slice(0, 10)),
  })), [persons]);

  const personDirectory = useMemo(() => buildPersonDirectory(personRoster), [personRoster]);

  const members = useMemo<OrgMember[]>(() => {
    const baseMembers = dataSource === 'firestore'
      ? localMembers
      : (localMembers.length > 0 ? localMembers : ORG_MEMBERS);
    if (!authUser) return baseMembers;
    if (baseMembers.some((m) => m.uid === authUser.uid)) return baseMembers;
    return [currentUser, ...baseMembers];
  }, [authUser, currentUser, dataSource, localMembers]);

  useEffect(() => {
    let cancelled = false;

    if (!firestoreEnabled || !db) {
      setDataSource(platformApiEnabled ? 'firestore' : 'local');
      setProjects(usesLocalSeedData ? PROJECTS : []);
      setLedgers(usesLocalSeedData ? LEDGERS : []);
      setTransactions(usesLocalSeedData ? TRANSACTIONS : []);
      setComments(usesLocalSeedData ? COMMENTS : []);
      setEvidences(usesLocalSeedData ? EVIDENCES : []);
      setAuditLogs(usesLocalSeedData ? AUDIT_LOGS : []);
      setParticipationEntries([]);
      setLocalMembers(usesLocalSeedData ? ORG_MEMBERS as Array<OrgMember & Record<string, unknown>> : []);

      if (platformApiEnabled && bffActor.idToken) {
        fetchProjectsViaBff({ tenantId: orgId, actor: bffActor })
          .then((nextProjects) => {
            if (!cancelled) setProjects(nextProjects);
          })
          .catch((error) => {
            reportError(error, {
              message: '[AppStore] BFF project fetch failed:',
              options: {
                level: 'error',
                tags: { surface: 'app_store', action: 'project_fetch' },
                extra: { orgId },
              },
            });
          });
      }

      return () => {
        cancelled = true;
      };
    }

    setDataSource('firestore');
    setLocalMembers([]);

    const projectsRequest = platformApiEnabled && bffActor.idToken
      ? fetchProjectsViaBff({ tenantId: orgId, actor: bffActor }).catch((error) => {
          reportError(error, {
            message: '[AppStore] BFF project fetch failed; falling back to Firestore:',
            options: {
              level: 'warning',
              tags: { surface: 'app_store', action: 'project_fetch_fallback' },
              extra: { orgId },
            },
          });
          return readOrgCollection(db, orgId, 'projects') as Promise<Project[]>;
        })
      : readOrgCollection(db, orgId, 'projects');

    Promise.all([
      readOrgCollection(db, orgId, 'members'),
      projectsRequest,
      readOrgCollection(db, orgId, 'ledgers'),
      readOrgCollection(db, orgId, 'transactions'),
      readOrgCollection(db, orgId, 'comments'),
      readOrgCollection(db, orgId, 'evidences'),
      readOrgCollection(db, orgId, 'auditLogs'),
      readOrgCollection(db, orgId, 'partEntries'),
    ]).then(([
      nextMembers,
      nextProjects,
      nextLedgers,
      nextTransactions,
      nextComments,
      nextEvidences,
      nextAuditLogs,
      nextParticipationEntries,
    ]) => {
      if (cancelled) return;
      setLocalMembers(nextMembers as Array<OrgMember & Record<string, unknown>>);
      setProjects(nextProjects as Project[]);
      setLedgers(nextLedgers as Ledger[]);
      setTransactions(nextTransactions as Transaction[]);
      setComments(nextComments as Comment[]);
      setEvidences(nextEvidences as Evidence[]);
      setAuditLogs((nextAuditLogs as AuditLog[]).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || '')));
      setParticipationEntries((nextParticipationEntries as ParticipationEntry[]).sort((a, b) => a.id.localeCompare(b.id)));
    }).catch((error) => {
      reportError(error, {
        message: '[AppStore] Firestore bulk fetch failed:',
        options: {
          level: 'error',
          tags: {
            surface: 'app_store',
            action: 'bulk_fetch',
          },
          extra: {
            orgId,
          },
        },
      });
    });

    return () => {
      cancelled = true;
    };
  }, [firestoreEnabled, db, orgId, usesLocalSeedData, platformApiEnabled, bffActor]);

  useEffect(() => {
    if (firestoreEnabled || !featureFlags.etlStagingLocalEnabled) return;

    let cancelled = false;
    fetch('/data/etl-staging-ui.json', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((payload: EtlStagingUiPayload) => {
        if (cancelled) return;
        if (Array.isArray(payload.projects) && payload.projects.length > 0) {
          setProjects(payload.projects);
        }
        if (Array.isArray(payload.members) && payload.members.length > 0) {
          setLocalMembers(payload.members as Array<OrgMember & Record<string, unknown>>);
        }
        if (Array.isArray(payload.ledgers) && payload.ledgers.length > 0) {
          setLedgers(payload.ledgers);
        }
        if (Array.isArray(payload.transactions) && payload.transactions.length > 0) {
          setTransactions(payload.transactions);
        }
        if (Array.isArray(payload.comments) && payload.comments.length > 0) {
          setComments(payload.comments);
        }
        if (Array.isArray(payload.evidences) && payload.evidences.length > 0) {
          setEvidences(payload.evidences);
        }
        if (Array.isArray(payload.auditLogs) && payload.auditLogs.length > 0) {
          setAuditLogs(payload.auditLogs);
        }
        if (Array.isArray(payload.participationEntries) && payload.participationEntries.length > 0) {
          setParticipationEntries(payload.participationEntries);
        }
      })
      .catch((err) => {
        console.error('[ETL staging] local json load failed:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [firestoreEnabled]);

  const addProject = useCallback(async (p: Project) => {
    await runStoreMutation('addProject', async () => {
      const normalizedProject = normalizeProjectRevenueFields(p, 'totalRevenueAmount');
      if (writeStrategy.target === 'bff') {
        const result = await upsertProjectViaBff({
          tenantId: orgId,
          actor: bffActor,
          project: normalizedProject as unknown as UpsertProjectPayload,
        });

        if (writeStrategy.mirrorRemoteWritesLocally) {
          setProjects((prev) => upsertLocalItem(prev, mergeProjectMutationResult(normalizedProject, result)));
        }
        return;
      }

      if (writeStrategy.target === 'firestore' && db) {
        await upsertProject(db, orgId, normalizedProject, auditActor);
        setProjects((prev) => upsertLocalItem(prev, normalizedProject));
        return;
      }

      setProjects((prev) => [...prev, normalizedProject]);
    });
  }, [runStoreMutation, writeStrategy, orgId, bffActor, db, auditActor]);

  const upsertMember = useCallback(async (member: OrgMember & Record<string, unknown>) => {
    await runStoreMutation('upsertMember', async () => {
      if (firestoreEnabled && db) {
        await upsertMemberFS(db, orgId, member, auditActor);
      }
      setLocalMembers((prev) => {
        const idx = prev.findIndex((m) => m.uid === member.uid);
        if (idx === -1) return [member, ...prev];
        const next = [...prev];
        next[idx] = { ...next[idx], ...member };
        return next;
      });
    });
  }, [runStoreMutation, firestoreEnabled, db, orgId, auditActor]);

  const removeMember = useCallback(async (uid: string) => {
    await runStoreMutation('removeMember', async () => {
      if (firestoreEnabled && db) {
        await deleteMemberFS(db, orgId, uid, auditActor);
      }
      setLocalMembers((prev) => prev.filter((m) => m.uid !== uid));
    });
  }, [runStoreMutation, firestoreEnabled, db, orgId, auditActor]);

  const updateProject = useCallback(async (id: string, updates: Partial<Project>) => {
    await runStoreMutation('updateProject', async () => {
      if (writeStrategy.target === 'bff') {
        const existing = projects.find((project) => project.id === id);
        if (existing) {
          const merged = normalizeProjectRevenueFields({ ...existing, ...updates } as Project, 'totalRevenueAmount');
          const result = await upsertProjectViaBff({
            tenantId: orgId,
            actor: bffActor,
            project: {
              ...merged,
              expectedVersion: existing.version ?? 1,
            },
          });

          if (writeStrategy.mirrorRemoteWritesLocally) {
            setProjects((prev) => prev.map((project) => (
              project.id === id
                ? mergeProjectMutationResult(project, result, merged)
                : project
            )));
          }
        }
        return;
      }

      if (writeStrategy.target === 'firestore' && db) {
        const existing = projects.find((project) => project.id === id);
        if (existing) {
          const merged = normalizeProjectRevenueFields({ ...existing, ...updates } as Project, 'totalRevenueAmount');
          await upsertProject(db, orgId, merged, auditActor);
          setProjects((prev) => upsertLocalItem(prev, merged));
        }
        return;
      }

      setProjects((prev) => prev.map((p) => (p.id === id ? normalizeProjectRevenueFields({ ...p, ...updates } as Project, 'totalRevenueAmount') : p)));
    });
  }, [runStoreMutation, writeStrategy, projects, orgId, bffActor, db, auditActor]);

  const patchProjectSnapshot = useCallback((project: Project) => {
    setProjects((prev) => prev.map((current) => (
      current.id === project.id
        ? normalizeProjectRevenueFields({ ...current, ...project } as Project, 'totalRevenueAmount')
        : current
    )));
  }, []);

  const trashProject = useCallback(async (id: string, reason?: string) => {
    await runStoreMutation('trashProject', async () => {
      const existing = projects.find((project) => project.id === id);
      if (!existing) return;
      const timestamp = new Date().toISOString();
      const normalizedReason = reason?.trim() || null;
      const patch: Partial<Project> = {
        trashedAt: timestamp,
        trashedById: currentUser.uid,
        trashedByEmail: currentUser.email || null,
        trashedReason: normalizedReason,
      };

      if (writeStrategy.target === 'bff') {
        const result = await trashProjectViaBff({
          tenantId: orgId,
          actor: bffActor,
          projectId: id,
          payload: {
            expectedVersion: existing.version ?? 1,
            reason: normalizedReason || undefined,
          },
        });

        setProjects((prev) => prev.map((project) => (
          project.id === id
            ? mergeProjectMutationResult(project, result, patch)
            : project
        )));
        return;
      }

      if (writeStrategy.target === 'firestore' && db) {
        await upsertProject(db, orgId, { ...existing, ...patch }, auditActor);
        setProjects((prev) => prev.map((project) => (project.id === id ? { ...project, ...patch } : project)));
        return;
      }

      setProjects((prev) => prev.map((project) => (project.id === id ? { ...project, ...patch } : project)));
    });
  }, [runStoreMutation, projects, currentUser.uid, currentUser.email, writeStrategy, orgId, bffActor, db, auditActor]);

  const restoreProject = useCallback(async (id: string) => {
    await runStoreMutation('restoreProject', async () => {
      const existing = projects.find((project) => project.id === id);
      if (!existing) return;
      const patch: Partial<Project> = {
        trashedAt: null,
        trashedById: null,
        trashedByEmail: null,
        trashedReason: null,
      };

      if (writeStrategy.target === 'bff') {
        const result = await restoreProjectViaBff({
          tenantId: orgId,
          actor: bffActor,
          projectId: id,
          payload: {
            expectedVersion: existing.version ?? 1,
          },
        });

        setProjects((prev) => prev.map((project) => (
          project.id === id
            ? mergeProjectMutationResult(project, result, patch)
            : project
        )));
        return;
      }

      if (writeStrategy.target === 'firestore' && db) {
        await upsertProject(db, orgId, { ...existing, ...patch }, auditActor);
        setProjects((prev) => prev.map((project) => (project.id === id ? { ...project, ...patch } : project)));
        return;
      }

      setProjects((prev) => prev.map((project) => (project.id === id ? { ...project, ...patch } : project)));
    });
  }, [runStoreMutation, projects, writeStrategy, orgId, bffActor, db, auditActor]);

  const addLedger = useCallback(async (l: Ledger) => {
    await runStoreMutation('addLedger', async () => {
      if (writeStrategy.target === 'bff') {
        await upsertLedgerViaBff({
          tenantId: orgId,
          actor: bffActor,
          ledger: l as any,
        });

        setLedgers((prev) => upsertLocalItem(prev, l));
        return;
      }

      if (writeStrategy.target === 'firestore' && db) {
        await upsertLedger(db, orgId, l, auditActor);
        setLedgers((prev) => upsertLocalItem(prev, l));
        return;
      }

      setLedgers((prev) => upsertLocalItem(prev, l));
    });
  }, [runStoreMutation, writeStrategy, orgId, bffActor, db, auditActor]);

  const addTransaction = useCallback(async (t: Transaction) => {
    await runStoreMutation('addTransaction', async () => {
      if (writeStrategy.target === 'bff') {
        await upsertTransactionViaBff({
          tenantId: orgId,
          actor: bffActor,
          transaction: t as any,
        });

        setTransactions((prev) => upsertLocalItem(prev, t));
        return;
      }

      if (writeStrategy.target === 'firestore' && db) {
        await upsertTransaction(db, orgId, t, auditActor);
        setTransactions((prev) => upsertLocalItem(prev, t));
        return;
      }

      setTransactions((prev) => upsertLocalItem(prev, t));
    });
  }, [runStoreMutation, writeStrategy, orgId, bffActor, db, auditActor]);

  const updateTransaction = useCallback(async (id: string, updates: Partial<Transaction>) => {
    await runStoreMutation('updateTransaction', async () => {
      if (writeStrategy.target === 'bff') {
        const existing = transactions.find((tx) => tx.id === id);
        if (existing) {
          await upsertTransactionViaBff({
            tenantId: orgId,
            actor: bffActor,
            transaction: {
              ...existing,
              ...updates,
              expectedVersion: existing.version ?? 1,
            } as any,
          });
        }

        setTransactions((prev) => updateLocalItem(prev, id, updates));
        return;
      }

      if (writeStrategy.target === 'firestore' && db) {
        const existing = transactions.find((tx) => tx.id === id);
        if (existing) {
          await upsertTransaction(db, orgId, { ...existing, ...updates }, auditActor);
        }
        setTransactions((prev) => updateLocalItem(prev, id, updates));
        return;
      }

      setTransactions((prev) => updateLocalItem(prev, id, updates));
    });
  }, [runStoreMutation, writeStrategy, transactions, orgId, bffActor, db, auditActor]);

  const changeTransactionState = useCallback(async (id: string, newState: TransactionState, reason?: string) => {
    await runStoreMutation('changeTransactionState', async () => {
      if (writeStrategy.target === 'bff') {
        const currentTx = transactions.find((tx) => tx.id === id);
        await changeTransactionStateViaBff({
          tenantId: orgId,
          actor: bffActor,
          transactionId: id,
          newState,
          expectedVersion: currentTx?.version ?? 1,
          reason,
        });

        setTransactions((prev) => updateLocalItem(prev, id, buildTransactionStateLocalPatch(newState, currentUser.uid, reason)));
        return;
      }

      if (writeStrategy.target === 'firestore' && db) {
        await changeTransactionStateFS(db, orgId, id, newState, auditActor, reason);
        setTransactions((prev) => updateLocalItem(prev, id, buildTransactionStateLocalPatch(newState, currentUser.uid, reason)));
        return;
      }

      setTransactions((prev) => updateLocalItem(prev, id, buildTransactionStateLocalPatch(newState, currentUser.uid, reason)));
    });
  }, [runStoreMutation, writeStrategy, transactions, orgId, bffActor, db, currentUser.uid, auditActor]);

  const addComment = useCallback(async (c: Comment) => {
    await runStoreMutation('addComment', async () => {
      if (writeStrategy.target === 'bff') {
        await addCommentViaBff({
          tenantId: orgId,
          actor: bffActor,
          transactionId: c.transactionId,
          comment: {
            id: c.id,
            content: c.content,
            authorName: c.authorName,
          },
        });

        setComments((prev) => upsertLocalItem(prev, c));
        return;
      }

      if (writeStrategy.target === 'firestore' && db) {
        await addCommentFS(db, orgId, c, auditActor);
        setComments((prev) => upsertLocalItem(prev, c));
        return;
      }

      setComments((prev) => upsertLocalItem(prev, c));
    });
  }, [runStoreMutation, writeStrategy, orgId, bffActor, db, auditActor]);

  const addEvidence = useCallback(async (e: Evidence) => {
    await runStoreMutation('addEvidence', async () => {
      if (writeStrategy.target === 'bff') {
        await addEvidenceViaBff({
          tenantId: orgId,
          actor: bffActor,
          transactionId: e.transactionId,
          evidence: {
            id: e.id,
            fileName: e.fileName,
            fileType: e.fileType,
            fileSize: e.fileSize,
            category: e.category,
            status: e.status,
          },
        });

        setEvidences((prev) => upsertLocalItem(prev, e));
        return;
      }

      if (writeStrategy.target === 'firestore' && db) {
        await addEvidenceFS(db, orgId, e, auditActor);
        setEvidences((prev) => upsertLocalItem(prev, e));
        return;
      }

      setEvidences((prev) => upsertLocalItem(prev, e));
    });
  }, [runStoreMutation, writeStrategy, orgId, bffActor, db, auditActor]);

  const addParticipation = useCallback(async (pe: ParticipationEntry) => {
    await runStoreMutation('addParticipation', async () => {
      if (firestoreEnabled && db) {
        await addPartEntry(db, orgId, pe, auditActor);
        setParticipationEntries((prev) => upsertLocalItem(prev, pe));
        return;
      }
      setParticipationEntries((prev) => upsertLocalItem(prev, pe));
    });
  }, [runStoreMutation, firestoreEnabled, db, orgId, auditActor]);

  const updateParticipation = useCallback(async (id: string, updates: Partial<ParticipationEntry>) => {
    await runStoreMutation('updateParticipation', async () => {
      if (firestoreEnabled && db) {
        await updatePartEntry(db, orgId, id, updates, auditActor);
        setParticipationEntries((prev) => updateLocalItem(prev, id, updates));
        return;
      }
      setParticipationEntries((prev) => updateLocalItem(prev, id, updates));
    });
  }, [runStoreMutation, firestoreEnabled, db, orgId, auditActor]);

  const removeParticipation = useCallback(async (id: string) => {
    await runStoreMutation('removeParticipation', async () => {
      if (firestoreEnabled && db) {
        await deletePartEntry(db, orgId, id, auditActor);
        setParticipationEntries((prev) => prev.filter((p) => p.id !== id));
        return;
      }
      setParticipationEntries((prev) => prev.filter((p) => p.id !== id));
    });
  }, [runStoreMutation, firestoreEnabled, db, orgId, auditActor]);

  const getProjectLedgers = useCallback((projectId: string) => {
    return ledgers.filter((l) => l.projectId === projectId);
  }, [ledgers]);

  const getLedgerTransactions = useCallback((ledgerId: string) => {
    return transactions.filter((t) => t.ledgerId === ledgerId);
  }, [transactions]);

  const getTransactionComments = useCallback((txId: string) => {
    return comments.filter((c) => c.transactionId === txId);
  }, [comments]);

  const getTransactionEvidences = useCallback((txId: string) => {
    return evidences.filter((e) => e.transactionId === txId);
  }, [evidences]);

  const displayProjects = useMemo(
    () => projects.map((project) => regularizeProjectOwnerNames(project, members)),
    [members, projects],
  );

  const getProjectById = useCallback((id: string) => {
    return displayProjects.find((p) => p.id === id);
  }, [displayProjects]);

  const getLedgerById = useCallback((id: string) => {
    return ledgers.find((l) => l.id === id);
  }, [ledgers]);

  const activeProjects = useMemo(
    () => displayProjects.filter((project) => !project.trashedAt),
    [displayProjects],
  );

  const value: AppState & AppActions = {
    org: { ...ORGANIZATION, id: orgId, members },
    currentUser,
    members,
    templates: LEDGER_TEMPLATES,
    projects: activeProjects,
    allProjects: displayProjects,
    ledgers,
    transactions,
    comments,
    evidences,
    auditLogs,
    participationEntries,
    persons,
    personRoster,
    personDirectory,
    dataSource,
    upsertMember,
    removeMember,
    addProject,
    updateProject,
    patchProjectSnapshot,
    trashProject,
    restoreProject,
    addLedger,
    addTransaction,
    updateTransaction,
    changeTransactionState,
    addComment,
    addEvidence,
    addParticipation,
    updateParticipation,
    removeParticipation,
    getProjectLedgers,
    getLedgerTransactions,
    getTransactionComments,
    getTransactionEvidences,
    getProjectById,
    getLedgerById,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppStore() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppStore must be used within AppProvider');
  return ctx;
}
