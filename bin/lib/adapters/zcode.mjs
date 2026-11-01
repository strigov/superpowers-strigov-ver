// adapters/zcode.mjs — the pass-through adapter of the `zcode` harness (the built-in profile `glm`): agent-dispatch
// runs the existing bin/zcode-dispatch wrapper and hands its stdout, stderr and exit code back unchanged
// (docs/superpowers/specs/2026-10-20-universal-dispatchers-design.md §3.1, §3.3 "Сквозные вызовы").
//
// A pass-through adapter returns data only — the argv of the wrapper, warnings, the jobs of `status --json` — and
// bin/lib/agent-dispatch.mjs runs the wrapper. zcode-dispatch parses its arguments strictly
// (parseArgs({ strict: true })), so --write, --profile and --role never reach it: the wrapper always runs ZCode in
// --mode yolo and pins the model itself. A profile's `model` picks one of the wrapper's pins (0.14.0: the built-in
// `glm-pro` → --model GLM-5.3); a profile without one runs the wrapper's default, GLM-5.3-Flash, with no --model.

const ID_RE = /^zt-\d{4,}$/;

export default {
  id: "zcode",
  kind: "pass-through",
  wrapper: { name: "zcode-dispatch", envVar: "AGENT_DISPATCH_ZCODE" },
  idPrefix: "zt-",
  // How a reviewer on this harness is held to reading (route's readOnly=): it is not — the wrapper runs --mode yolo.
  readOnly: "none",
  // Every task takes the ZCode reservation and may write, with or without --write.
  alwaysWrites: true,
  // Pinned by the wrapper: the default (zcode-dispatch.mjs PINNED_MODEL "GLM-5.3-Flash$max") and the models its
  // --model takes (zcode-dispatch.mjs MODEL_IDS; tests/test-agent-dispatch.sh checks the two lists agree). Every pin
  // runs at reasoning level max, so a profile's effort can only be "max".
  pinned: { model: "GLM-5.3-Flash", effort: "max" },
  models: ["GLM-5.3-Flash", "GLM-5.3"],
  modelOf: (profile) => profile?.model ?? "GLM-5.3-Flash",

  resumeIdOk: (id) => ID_RE.test(id),

  // zcode-dispatch task --background [--model M] [--cwd W] [--resume-task zt-N | --fresh] --prompt-file F
  taskArgv({ profile, cwd, resumeTaskId, fresh, promptFile }) {
    return [
      "task",
      "--background",
      ...(profile?.model !== undefined ? ["--model", profile.model] : []),
      ...(cwd !== undefined ? ["--cwd", cwd] : []),
      ...(resumeTaskId !== undefined ? ["--resume-task", resumeTaskId] : fresh ? ["--fresh"] : []),
      "--prompt-file",
      promptFile,
    ];
  },

  taskWarnings({ profileName, write }) {
    return write ? [] : [`${profileName} has no read-only mode: zcode-dispatch runs this task with write access (--mode yolo) and takes the ZCode reservation`];
  },

  // `zcode-dispatch status --json` → { workspaceRoot, running: [record], recent: [record] }. ZCode records carry no
  // profile and no write flag: every ZCode job may write. The profile is the first zcode profile whose model the
  // record names ("GLM-5.3$max" → the one with model GLM-5.3), else profileName.
  statusJobs(data, { profileName, zcodeProfiles = [] }) {
    const byModel = (record) => {
      const id = typeof record.model === "string" ? record.model.split("$")[0] : "GLM-5.3-Flash";
      return zcodeProfiles.find((entry) => entry.model.toLowerCase() === id.toLowerCase())?.name ?? profileName;
    };
    const records = [...(Array.isArray(data?.running) ? data.running : []), ...(Array.isArray(data?.recent) ? data.recent : [])];
    return records
      .filter((record) => record && typeof record.id === "string")
      .map((record) => ({
        id: record.id,
        profile: byModel(record),
        harness: "zcode",
        status: record.status ?? "-",
        errorClass: record.errorClass ?? null,
        write: record.write !== false,
        cwd: record.workspaceRoot ?? data?.workspaceRoot ?? null,
        pid: Number.isInteger(record.runnerPid) ? record.runnerPid : null,
      }));
  },
};
