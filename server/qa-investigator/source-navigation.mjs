import { createHash } from "node:crypto";

const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const schema = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const invalid = (code) => {
  throw Object.assign(new Error(code), { safeCode: code });
};
const strict = (input, fields) => {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !fields.includes(key))
  )
    invalid("invalid_scope");
};
const pageNumber = (value) =>
  Number.isSafeInteger(value) && value >= 1 && value <= 100000;
const safePath = (value) =>
  typeof value === "string" &&
  value.length <= 500 &&
  /^[A-Za-z0-9_.\/-]+$/.test(value) &&
  !value.split("/").some((part) => !part || part === "." || part === "..") &&
  !/(?:^|\/)(?:\.env(?:\.|$)|node_modules|vendor|dist|build|secrets?|credentials?)(?:\/|$)/i.test(
    value,
  ) &&
  !/\.(?:pem|key|p12|pfx|jks)$/i.test(value);
const textPath = (value) =>
  /\.(?:mjs|cjs|js|jsx|ts|tsx|java|kt|json|yml|yaml|gradle|sql)$/.test(value);

// Git tree navigation discovers callers and domain owners. It is not a call graph
// and does not establish that an observed request executed the returned source.
export function createSourceNavigation({
  policy,
  resolveDeployedRevision,
  githubToken,
  json,
  tool,
}) {
  const roots = policy.allowedSourceRoots || [];
  if (
    !Array.isArray(roots) ||
    roots.some(
      (root) =>
        ![
          "src/",
          "server/",
          "policies/",
          "api/",
          "scripts/",
          ".github/workflows/",
        ].includes(root),
    )
  ) {
    throw new Error("invalid_live_source_policy");
  }
  const permitted = (path) =>
    safePath(path) &&
    textPath(path) &&
    (policy.allowedPaths.includes(path) ||
      roots.some((root) => path.startsWith(root)));
  const base = `https://api.github.com/repos/merryAI-dev/${policy.repository}`;
  const knownCommits = new Map();
  const treeCache = new Map();
  const blobCache = new Map();
  const revisionParameter = {
    type: "string",
    enum: ["web_current", "web_incident", "jvm_current", "jvm_incident"],
  };

  async function revision(target, signal) {
    if (!revisionParameter.enum.includes(target)) invalid("invalid_scope");
    const resolved = await resolveDeployedRevision?.({
      repository: policy.repository,
      target,
      signal,
    });
    if (!sha(resolved?.revision) || resolved.repository !== policy.repository)
      invalid("deployment_revision_unverified");
    return {
      repository: policy.repository,
      revision: resolved.revision,
      revision_target: target,
      deployment_id: /^dpl_[A-Za-z0-9]+$/.test(resolved.deployment_id || "")
        ? resolved.deployment_id
        : null,
      runtime_revision: /^innerplatform-jvm-weekly-api-live-[a-z0-9-]+$/.test(
        resolved.runtime_revision || "",
      )
        ? resolved.runtime_revision
        : null,
      request_log_evidence_ids: Array.isArray(resolved.request_log_evidence_ids)
        ? resolved.request_log_evidence_ids.filter((id) =>
            /^ev_[a-f0-9]{64}$/.test(id),
          )
        : [],
      deployment_observation: resolved.deployment_observation || null,
      execution_verified: false,
    };
  }

  function targetForPath(target, path) {
    if (
      path.startsWith("server/jvm-weekly-api/") !==
      ["jvm_current", "jvm_incident"].includes(target)
    )
      invalid("source_service_revision_mismatch");
  }

  async function tree(resolved, signal) {
    const key = resolved.revision;
    if (!treeCache.has(key)) {
      const token = await githubToken(signal);
      const commit = await json(`${base}/git/commits/${key}`, token, {
        signal,
      });
      if (commit.sha !== key || !sha(commit.tree?.sha))
        invalid("source_invalid_response");
      const data = await json(
        `${base}/git/trees/${commit.tree.sha}?recursive=1`,
        token,
        { signal },
      );
      if (
        data.sha !== commit.tree.sha ||
        !Array.isArray(data.tree) ||
        typeof data.truncated !== "boolean"
      )
        invalid("source_invalid_response");
      treeCache.set(key, {
        truncated: data.truncated,
        files: data.tree
          .filter(
            (entry) =>
              entry.type === "blob" &&
              ["100644", "100755"].includes(entry.mode) &&
              sha(entry.sha) &&
              Number.isSafeInteger(entry.size) &&
              entry.size >= 0 &&
              permitted(entry.path),
          )
          .map(({ path, sha: blob_sha, size }) => ({ path, blob_sha, size }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      });
    }
    return treeCache.get(key);
  }

  async function file(resolved, path, signal) {
    if (!permitted(path)) invalid("invalid_scope");
    targetForPath(resolved.revision_target, path);
    const inventory = await tree(resolved, signal);
    const entry = inventory.files.find((item) => item.path === path);
    if (!entry)
      invalid(
        inventory.truncated
          ? "source_tree_incomplete"
          : "source_path_not_found",
      );
    if (entry.size > 4000000) invalid("source_response_too_large");
    if (!blobCache.has(entry.blob_sha)) {
      const data = await json(
        `${base}/git/blobs/${entry.blob_sha}`,
        await githubToken(signal),
        { signal, maxBytes: 6000000 },
      );
      if (
        data.sha !== entry.blob_sha ||
        data.encoding !== "base64" ||
        typeof data.content !== "string"
      )
        invalid("source_invalid_response");
      const bytes = Buffer.from(data.content, "base64");
      if (
        data.size !== entry.size ||
        bytes.length !== entry.size ||
        createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex") !== entry.blob_sha
      )
        invalid("source_invalid_response");
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        invalid("source_invalid_response");
      }
      if (text.includes("\0")) invalid("source_invalid_response");
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      blobCache.set(entry.blob_sha, {
        lines,
        file_sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    return { ...entry, ...blobCache.get(entry.blob_sha) };
  }

  const registry = {};
  registry.list_live_source_files = tool(
    "list_live_source_files",
    "Discover source files at a server-resolved deployment revision. Filter path text then page through results to follow UI → BFF → domain → persistence. JVM must use its own revision. A truncated Git tree is incomplete, never proof a file is absent.",
    schema(
      {
        target: revisionParameter,
        path_contains: { type: "string", maxLength: 100 },
        page: { type: "integer", minimum: 1 },
      },
      ["target", "path_contains", "page"],
    ),
    async (args, signal) => {
      strict(args, ["target", "path_contains", "page"]);
      if (
        typeof args.path_contains !== "string" ||
        args.path_contains.length > 100 ||
        /[\x00-\x1f]/.test(args.path_contains) ||
        !pageNumber(args.page)
      )
        invalid("invalid_scope");
      const resolved = await revision(args.target, signal);
      const inventory = await tree(resolved, signal);
      const files = inventory.files.filter(
        (item) =>
          item.path.startsWith("server/jvm-weekly-api/") ===
            ["jvm_current", "jvm_incident"].includes(args.target) &&
          item.path.toLowerCase().includes(args.path_contains.toLowerCase()),
      );
      const start = (args.page - 1) * 100;
      return {
        ...resolved,
        rows: files.slice(start, start + 100),
        next_page: start + 100 < files.length ? args.page + 1 : null,
        coverage: {
          complete: !inventory.truncated && start === 0 && files.length <= 100,
          tree_truncated: inventory.truncated,
          matching_files: files.length,
          scope: "permitted_source_file_inventory",
          page: args.page,
        },
      };
    },
  );

  registry.search_live_source = tool(
    "search_live_source",
    "Find literal symbols/error codes/imports/callers across selected source files at one deployment revision. Results include exact lines and blob hashes. Continue with read_live_source_range. This is lexical matching, not proof of an executed call graph.",
    schema(
      {
        target: revisionParameter,
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
        },
        needle: { type: "string", minLength: 2, maxLength: 160 },
        page: { type: "integer", minimum: 1 },
      },
      ["target", "paths", "needle", "page"],
    ),
    async (args, signal) => {
      strict(args, ["target", "paths", "needle", "page"]);
      if (
        !Array.isArray(args.paths) ||
        !args.paths.length ||
        args.paths.length > 20 ||
        args.paths.some((path) => !permitted(path)) ||
        new Set(args.paths).size !== args.paths.length ||
        typeof args.needle !== "string" ||
        args.needle.length < 2 ||
        args.needle.length > 160 ||
        /[\x00-\x1f]/.test(args.needle) ||
        !pageNumber(args.page)
      )
        invalid("invalid_scope");
      const resolved = await revision(args.target, signal),
        matches = [];
      for (const path of args.paths) {
        const source = await file(resolved, path, signal);
        source.lines.forEach((text, index) => {
          if (text.includes(args.needle))
            matches.push({
              path,
              blob_sha: source.blob_sha,
              line: index + 1,
              text: text.slice(0, 1000),
              truncated: text.length > 1000,
            });
        });
      }
      const start = (args.page - 1) * 100,
        rows = matches.slice(start, start + 100);
      return {
        ...resolved,
        rows,
        next_page: start + 100 < matches.length ? args.page + 1 : null,
        coverage: {
          complete:
            start === 0 &&
            matches.length <= 100 &&
            rows.every((row) => !row.truncated),
          scope: "selected_files_literal_search",
          files_scanned: args.paths,
          total_matches: matches.length,
          not_a_call_graph: true,
        },
      };
    },
  );

  registry.read_live_source_range = tool(
    "read_live_source_range",
    "Read exact source lines using the service-specific deployment revision. Use this for discovered callers, validation rules, policy and storage implementation. No model-selected Git ref, no working-tree fallback.",
    schema(
      {
        target: revisionParameter,
        path: { type: "string" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
      ["target", "path", "start_line", "end_line"],
    ),
    async (args, signal) => {
      strict(args, ["target", "path", "start_line", "end_line"]);
      if (
        !Number.isSafeInteger(args.start_line) ||
        !Number.isSafeInteger(args.end_line) ||
        args.start_line < 1 ||
        args.end_line < args.start_line ||
        args.end_line - args.start_line >= 160
      )
        invalid("invalid_scope");
      const resolved = await revision(args.target, signal),
        source = await file(resolved, args.path, signal);
      if (args.end_line > source.lines.length) invalid("invalid_scope");
      const rows = source.lines
        .slice(args.start_line - 1, args.end_line)
        .map((text, index) => ({
          line: args.start_line + index,
          text: text.slice(0, 1000),
          truncated: text.length > 1000,
        }));
      return {
        ...resolved,
        path: args.path,
        blob_sha: source.blob_sha,
        file_sha256: source.file_sha256,
        line_count: source.lines.length,
        rows,
        coverage: {
          complete: rows.every((row) => !row.truncated),
          scope: "requested_source_range",
          historical_request_execution_verified: false,
        },
      };
    },
  );

  registry.list_live_file_history = tool(
    "list_live_file_history",
    "Find prior changes to the suspected source file, anchored at its deployment revision. History suggests checks; a previous fix is not proof of the current cause. Read each candidate patch with read_live_hotfix_diff.",
    schema(
      {
        target: revisionParameter,
        path: { type: "string" },
        page: { type: "integer", minimum: 1 },
      },
      ["target", "path", "page"],
    ),
    async (args, signal) => {
      strict(args, ["target", "path", "page"]);
      if (!permitted(args.path) || !pageNumber(args.page))
        invalid("invalid_scope");
      targetForPath(args.target, args.path);
      const resolved = await revision(args.target, signal);
      const query = new URLSearchParams({
        sha: resolved.revision,
        path: args.path,
        per_page: "30",
        page: String(args.page),
      });
      const data = await json(
        `${base}/commits?${query}`,
        await githubToken(signal),
        { signal },
      );
      if (!Array.isArray(data) || data.some((item) => !sha(item.sha)))
        invalid("source_invalid_response");
      const rows = data.map((item) => {
        knownCommits.set(
          `${args.target}:${item.sha}:${args.path}`,
          resolved.revision,
        );
        return {
          commit_sha: item.sha,
          path: args.path,
          committed_at: item.commit?.committer?.date || null,
          title: String(item.commit?.message || "")
            .split("\n")[0]
            .slice(0, 300),
          url: `https://github.com/merryAI-dev/${policy.repository}/commit/${item.sha}`,
        };
      });
      return {
        ...resolved,
        requested_target: args.target,
        requested_path: args.path,
        rows,
        next_page: data.length === 30 ? args.page + 1 : null,
        coverage: {
          complete: args.page === 1 && data.length < 30,
          scope: "selected_file_history",
          page: args.page,
          historical_precedent_only: true,
        },
      };
    },
    (args) =>
      args &&
      permitted(args.path) &&
      pageNumber(args.page) &&
      revisionParameter.enum.includes(args.target) &&
      ["jvm_current", "jvm_incident"].includes(args.target) ===
        args.path.startsWith("server/jvm-weekly-api/")
        ? { requested_target: args.target, requested_path: args.path }
        : {},
  );

  registry.read_live_hotfix_diff = tool(
    "read_live_hotfix_diff",
    "Read a previously discovered historical commit patch for exactly the permitted file. The source history tool must first observe this commit. Patch truncation or omitted patches are explicit; authors and other files are excluded.",
    schema(
      {
        target: revisionParameter,
        path: { type: "string" },
        commit_sha: { type: "string", pattern: "^[a-f0-9]{40}$" },
        page: { type: "integer", minimum: 1 },
      },
      ["target", "path", "commit_sha", "page"],
    ),
    async (args, signal) => {
      strict(args, ["target", "path", "commit_sha", "page"]);
      if (
        !permitted(args.path) ||
        !sha(args.commit_sha) ||
        !pageNumber(args.page)
      )
        invalid("invalid_scope");
      const anchor = knownCommits.get(
        `${args.target}:${args.commit_sha}:${args.path}`,
      );
      if (!anchor) invalid("history_commit_unobserved");
      const data = await json(
        `${base}/commits/${args.commit_sha}?per_page=100&page=${args.page}`,
        await githubToken(signal),
        { signal },
      );
      if (data.sha !== args.commit_sha || !Array.isArray(data.files))
        invalid("source_invalid_response");
      const entry = data.files.find((item) => item.filename === args.path);
      return {
        repository: policy.repository,
        revision: anchor,
        revision_target: args.target,
        commit_sha: args.commit_sha,
        rows: entry
          ? [
              {
                path: args.path,
                status: [
                  "added",
                  "removed",
                  "modified",
                  "renamed",
                  "copied",
                  "changed",
                  "unchanged",
                ].includes(entry.status)
                  ? entry.status
                  : null,
                patch:
                  typeof entry.patch === "string"
                    ? entry.patch.slice(0, 20000)
                    : null,
                patch_truncated:
                  typeof entry.patch !== "string" || entry.patch.length > 20000,
              },
            ]
          : [],
        next_page: !entry && data.files.length === 100 ? args.page + 1 : null,
        coverage: {
          complete:
            !!entry &&
            typeof entry.patch === "string" &&
            entry.patch.length <= 20000,
          scope: "returned_patch_display_range",
          upstream_patch_completeness_verified: false,
          historical_precedent_only: true,
          current_cause_proven: false,
        },
      };
    },
  );
  const verifiedHistory = (item) => {
    if (
      item?.source !== "list_live_file_history" ||
      item.status !== "available" ||
      !/^ev_[a-f0-9]{64}$/.test(item.evidence_id || "") ||
      !/^[a-f0-9]{64}$/.test(item.content_hash || "") ||
      item.evidence_id !== `ev_${item.content_hash}` ||
      item.repository !== policy.repository ||
      !sha(item.revision) ||
      item.revision_target !== item.requested_target ||
      !revisionParameter.enum.includes(item.requested_target) ||
      !permitted(item.requested_path) ||
      ["jvm_current", "jvm_incident"].includes(item.requested_target) !==
        item.requested_path.startsWith("server/jvm-weekly-api/") ||
      !Array.isArray(item.rows) ||
      item.rows.length > 30 ||
      item.rows.some(
        (row) => !sha(row.commit_sha) || row.path !== item.requested_path,
      )
    )
      return false;
    const {
      evidence_id,
      content_hash,
      observed_at,
      source,
      status,
      cause_status,
      ...result
    } = item;
    return (
      createHash("sha256")
        .update(JSON.stringify({ source, ...result }))
        .digest("hex") === content_hash
    );
  };
  Object.defineProperty(registry.read_live_hotfix_diff, "blockedBy", {
    value: ({ evidence }) => {
      const history = [...evidence.values()].filter(
        (item) =>
          item?.source === "list_live_file_history" &&
          /^ev_[a-f0-9]{64}$/.test(item.evidence_id || "") &&
          revisionParameter.enum.includes(item.requested_target) &&
          permitted(item.requested_path) &&
          ["jvm_current", "jvm_incident"].includes(item.requested_target) ===
            item.requested_path.startsWith("server/jvm-weekly-api/"),
      );
      if (!history.length) return null;
      // Any observed commit is a valid exact input; a missing history call for
      // another path cannot excuse skipping a reachable diff.
      if (history.some((item) => verifiedHistory(item) && item.rows.length))
        return null;
      const blocked = history.filter(
        (item) =>
          (item.status === "unavailable" &&
            [
              "deployment_revision_unverified",
              "source_credentials_missing",
              "source_auth_unavailable",
              "source_access_denied",
              "source_unavailable",
              "source_invalid_response",
              "source_response_too_large",
            ].includes(item.error_code) &&
            (() => {
              const { evidence_id, content_hash, ...body } = item;
              return (
                /^[a-f0-9]{64}$/.test(content_hash || "") &&
                evidence_id === `ev_${content_hash}` &&
                createHash("sha256")
                  .update(JSON.stringify(body))
                  .digest("hex") === content_hash
              );
            })()) ||
          (verifiedHistory(item) &&
            item.coverage?.complete === true &&
            item.rows.length === 0),
      );
      if (!blocked.length) return null;
      return {
        evidence_ids: blocked.map((item) => item.evidence_id),
        reason_code: "history_commit_not_observed_for_bounded_file",
      };
    },
  });
  Object.defineProperty(registry, "observeEvidence", {
    value: (item) => {
      if (!verifiedHistory(item)) return;
      for (const row of item.rows)
        knownCommits.set(
          `${item.requested_target}:${row.commit_sha}:${item.requested_path}`,
          item.revision,
        );
    },
  });
  return registry;
}
