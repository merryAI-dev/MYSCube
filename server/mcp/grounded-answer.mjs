export async function loadPreviousReportSnapshots({ db, job, authorize }) {
  await authorize();
  for (const turn of [...(job.turns || [])].reverse()) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(turn.jobId || '')) continue;
    const source = (await db.doc(`settlement_agent_jobs/${turn.jobId}`).get()).data();
    if (!source || source.status !== 'succeeded'
      || ['teamId', 'channelId', 'slackUserId', 'threadTs'].some((key) => source[key] !== job[key])) continue;
    if (!Array.isArray(source.reportSnapshots) || !source.reportSnapshots.length) continue;
    const snapshots = source.reportSnapshots;
    if (snapshots.length > 5 || JSON.stringify(snapshots).length > 200000) throw new Error('report_snapshot_unavailable');
    for (const { report } of snapshots) {
      if (!report || !Array.isArray(report.rows) || !Number.isFinite(Date.parse(report.queriedAt))
        || report.coverage !== 'accessible_registered_projects') throw new Error('report_snapshot_unavailable');
      for (let offset = 0; offset < report.rows.length; offset += 100) {
        const rows = report.rows.slice(offset, offset + 100);
        if (rows.some((row) => typeof row.projectId !== 'string' || !row.projectId || row.projectId.includes('/'))) throw new Error('report_snapshot_unavailable');
        const docs = await db.getAll(...rows.map((row) => db.doc(`orgs/mysc/projects/${row.projectId}`)), { fieldMask: ['trashedAt'] });
        if (docs.some((doc) => !doc.exists || doc.data().trashedAt)) throw new Error('report_snapshot_unavailable');
      }
    }
    return structuredClone(snapshots);
  }
  return [];
}
