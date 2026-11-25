export function allowedPipelineEnvKeys() {
  return new Set((process.env.MCP_MEDIA_ALLOWED_ENV_KEYS || "").split(",").map((key) => key.trim()).filter((key) => /^[A-Z_][A-Z0-9_]*$/.test(key)));
}

export function pipelineTemplate(value, context) {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)\}\}$/);
    if (whole) {
      const [root, ...path] = whole[1].split(".");
      let current = root === "env" ? (context.allowedEnv.has(path[0]) ? process.env[path.shift()] : undefined) : context[root];
      for (const key of path) current = Object.hasOwn(current ?? {}, key) ? current[key] : undefined;
      if (current === undefined || current === null) throw new Error("Pipeline template value unavailable");
      return current;
    }
    return value.replace(/\{\{([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)\}\}/g, (token) => {
      const path = token.slice(2, -2).split(".");
      const root = path.shift();
      let current = root === "env" ? (context.allowedEnv.has(path[0]) ? process.env[path.shift()] : undefined) : context[root];
      for (const key of path) current = Object.hasOwn(current ?? {}, key) ? current[key] : undefined;
      if (current === undefined || current === null) throw new Error("Pipeline template value unavailable");
      return typeof current === "object" ? JSON.stringify(current) : String(current);
    });
  }
  if (Array.isArray(value)) return value.map((item) => pipelineTemplate(item, context));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, pipelineTemplate(item, context)]));
  return value;
}

export function pipelinePath(obj, path) {
  if (typeof path !== "string" || !/^[\w-]+(?:\.[\w-]+|\[\d+\])*$/.test(path)) return undefined;
  return path.replace(/\[(\d+)\]/g, ".$1").split(".").reduce((v, key) => Object.hasOwn(v ?? {}, key) ? v[key] : undefined, obj);
}

export function assertPipelineResultSafe(result, keys) {
  const serialized = JSON.stringify(result);
  if (keys.some((key) => process.env[key] && serialized?.includes(process.env[key]))) throw new Error("Pipeline result contains a secret");
}
