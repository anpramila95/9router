import {
  getValidAccessToken,
  buildAuthUrl,
  refreshGoogleToken,
} from "./auth.js";
import {
  getGcalAccounts,
  disconnectGcalAccount,
  savePendingAction,
  getPendingAction,
  updateGcalTokens,
} from "./store.js";

const GCAL_API_BASE = "https://www.googleapis.com/calendar/v3";

export const CALENDAR_TOOLS = [
  {
    name: "calendar.accounts.list",
    description:
      "Xem danh sách tất cả các tài khoản Google Calendar đã kết nối với API key này (hỗ trợ nhiều tài khoản).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "calendar.accounts.add",
    description:
      "Tạo link đăng nhập OAuth kết nối tài khoản Google Calendar. Khi gọi tool này, hãy trả link auth_url về ngay cho người dùng mở trên trình duyệt.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "calendar.accounts.disconnect",
    description:
      "Ngắt kết nối/xóa 1 tài khoản Google Calendar theo email (hoặc xóa tất cả tài khoản nếu không truyền email).",
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description:
            "Email tài khoản Google muốn xóa/ngắt kết nối. Bỏ trống để xóa tất cả.",
        },
      },
    },
  },
  {
    name: "calendar.events.list",
    description:
      "List events from a Google Calendar with filters (timeMin, timeMax, search query).",
    inputSchema: {
      type: "object",
      properties: {
        account_email: {
          type: "string",
          description:
            "Which connected Google account to use. Omit for default.",
        },
        calendar_id: {
          type: "string",
          default: "primary",
          description: "Calendar ID, default is 'primary'.",
        },
        time_min: {
          type: "string",
          description:
            "ISO 8601 start date-time (e.g. '2026-01-20T00:00:00Z').",
        },
        time_max: {
          type: "string",
          description: "ISO 8601 end date-time (e.g. '2026-01-20T23:59:59Z').",
        },
        query: { type: "string", description: "Text search query." },
        max_results: { type: "number", default: 25 },
      },
    },
  },
  {
    name: "calendar.events.create",
    description:
      "Create a new event in Google Calendar. If not authenticated, returns an auth URL and pauses execution until user approves.",
    inputSchema: {
      type: "object",
      properties: {
        account_email: {
          type: "string",
          description:
            "Which connected Google account to use. Omit for default.",
        },
        calendar_id: { type: "string", default: "primary" },
        summary: { type: "string", description: "Event title." },
        description: {
          type: "string",
          description: "Event description/notes.",
        },
        location: { type: "string", description: "Event location." },
        start: {
          type: "object",
          description:
            "{ dateTime: '2026-01-20T09:00:00+07:00' } or { date: '2026-01-20' } for all-day.",
        },
        end: {
          type: "object",
          description:
            "{ dateTime: '2026-01-20T10:00:00+07:00' } or { date: '2026-01-20' }.",
        },
        attendees: {
          type: "array",
          items: { type: "object", properties: { email: { type: "string" } } },
        },
        send_updates: {
          type: "string",
          enum: ["all", "externalOnly", "none"],
          default: "none",
        },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "calendar.events.get",
    description: "Get details of a specific event by ID.",
    inputSchema: {
      type: "object",
      properties: {
        account_email: { type: "string" },
        calendar_id: { type: "string", default: "primary" },
        event_id: { type: "string" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "calendar.events.update",
    description: "Update an existing Google Calendar event.",
    inputSchema: {
      type: "object",
      properties: {
        account_email: { type: "string" },
        calendar_id: { type: "string", default: "primary" },
        event_id: { type: "string" },
        summary: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        start: { type: "object" },
        end: { type: "object" },
        attendees: { type: "array", items: { type: "object" } },
      },
      required: ["event_id"],
    },
  },
  {
    name: "calendar.events.delete",
    description: "Delete an event from Google Calendar.",
    inputSchema: {
      type: "object",
      properties: {
        account_email: { type: "string" },
        calendar_id: { type: "string", default: "primary" },
        event_id: { type: "string" },
        send_updates: {
          type: "string",
          enum: ["all", "externalOnly", "none"],
          default: "none",
        },
      },
      required: ["event_id"],
    },
  },
  {
    name: "calendar.freebusy.query",
    description: "Check availability / busy slots across calendars.",
    inputSchema: {
      type: "object",
      properties: {
        account_email: { type: "string" },
        time_min: { type: "string", description: "ISO 8601 start date-time." },
        time_max: { type: "string", description: "ISO 8601 end date-time." },
        items: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" } } },
          description: "List of calendar IDs, e.g. [{ id: 'primary' }]",
        },
      },
      required: ["time_min", "time_max"],
    },
  },
  {
    name: "calendar.pending.status",
    description:
      "Check the status/result of a pending deferred action after user authentication.",
    inputSchema: {
      type: "object",
      properties: {
        action_id: { type: "string" },
      },
      required: ["action_id"],
    },
  },
];

export function isCalendarTool(name) {
  return typeof name === "string" && name.startsWith("calendar.");
}

function getCallbackUri(request) {
  const host = request.headers.get("host") || "localhost:20127";
  const proto =
    request.headers.get("x-forwarded-proto") ||
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/mcp/calendar/callback`;
}

async function googleRequest(path, accessToken, init = {}) {
  const url = new URL(`${GCAL_API_BASE}/${path}`);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined && v !== null && v !== "")
        url.searchParams.set(k, String(v));
    }
  }
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${accessToken}`,
    },
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const msg =
      data?.error?.message ||
      `Google Calendar HTTP ${response.status}: ${text.slice(0, 300)}`;
    const err = new Error(msg);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function executeCalendarToolDirect(account, toolName, args) {
  let token = account.accessToken;
  const calId = encodeURIComponent(args.calendar_id || "primary");

  const runWithToken = async (t) => {
    switch (toolName) {
      case "calendar.events.list": {
        return googleRequest(`calendars/${calId}/events`, t, {
          method: "GET",
          query: {
            timeMin: args.time_min,
            timeMax: args.time_max,
            q: args.query,
            maxResults: args.max_results ?? 25,
            singleEvents: "true",
            orderBy: "startTime",
          },
        });
      }
      case "calendar.events.create": {
        let start = args.start;
        let end = args.end;

        if (typeof start === "string") {
          start = start.includes("T") ? { dateTime: start } : { date: start };
        }
        if (typeof end === "string") {
          end = end.includes("T") ? { dateTime: end } : { date: end };
        }

        // Auto-derive end if missing
        if (!end && start) {
          if (start.date) {
            end = { date: start.date };
          } else if (start.dateTime) {
            const startDate = new Date(start.dateTime);
            const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // default 1 hour
            end = { dateTime: endDate.toISOString() };
          }
        }

        const body = {
          summary: args.summary,
          description: args.description,
          location: args.location,
          start,
          end,
          attendees: args.attendees,
        };
        return googleRequest(`calendars/${calId}/events`, t, {
          method: "POST",
          headers: { "content-type": "application/json" },
          query: { sendUpdates: args.send_updates || "none" },
          body: JSON.stringify(body),
        });
      }
      case "calendar.events.get": {
        const evId = encodeURIComponent(args.event_id);
        return googleRequest(`calendars/${calId}/events/${evId}`, t, {
          method: "GET",
        });
      }
      case "calendar.events.update": {
        const evId = encodeURIComponent(args.event_id);
        const body = {
          summary: args.summary,
          description: args.description,
          location: args.location,
          start: args.start,
          end: args.end,
          attendees: args.attendees,
        };
        return googleRequest(`calendars/${calId}/events/${evId}`, t, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      case "calendar.events.delete": {
        const evId = encodeURIComponent(args.event_id);
        await googleRequest(`calendars/${calId}/events/${evId}`, t, {
          method: "DELETE",
          query: { sendUpdates: args.send_updates || "none" },
        });
        return { success: true, deleted: true, event_id: args.event_id };
      }
      case "calendar.freebusy.query": {
        const body = {
          timeMin: args.time_min,
          timeMax: args.time_max,
          items: args.items || [{ id: "primary" }],
        };
        return googleRequest("freeBusy", t, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      default:
        throw new Error(`Unknown calendar tool: ${toolName}`);
    }
  };

  try {
    return await runWithToken(token);
  } catch (err) {
    if ((err.status === 401 || err.status === 403) && account.refreshToken) {
      const refreshed = await refreshGoogleToken(account.refreshToken);
      await updateGcalTokens(account.id, refreshed);
      return await runWithToken(refreshed.accessToken);
    }
    throw err;
  }
}

export async function dispatchCalendarTool({ apiKeyId, name, args, request }) {
  if (name === "calendar.accounts.list") {
    const accounts = await getGcalAccounts(apiKeyId);
    return {
      total: accounts.length,
      accounts: accounts.map((a) => ({
        id: a.id,
        email: a.email,
        scope: a.scope,
        expiresAt: a.expiresAt,
        createdAt: a.createdAt,
      })),
    };
  }

  if (name === "calendar.accounts.disconnect") {
    const ok = await disconnectGcalAccount(apiKeyId, args.email || null);
    return {
      disconnected: ok,
      email: args.email || "all",
      message: ok
        ? "Google Calendar account(s) disconnected."
        : "No matching active account found.",
    };
  }

  if (name === "calendar.accounts.add" || name === "calendar.auth.getUrl") {
    const host = request.headers.get("host") || "localhost:20127";
    const proto =
      request.headers.get("x-forwarded-proto") ||
      (host.startsWith("localhost") ? "http" : "https");
    const apiKeyString = auth(request);
    const keyParam = apiKeyString ? `apiKey=${encodeURIComponent(apiKeyString)}` : `k=${encodeURIComponent(apiKeyId)}`;
    const shortUrl = `${proto}://${host}/mcp/calendar/connect?${keyParam}`;

    return {
      auth_url: shortUrl,
      message: `Vui lòng gửi link này cho người dùng mở trên trình duyệt: ${shortUrl}`,
    };
  }

  if (name === "calendar.pending.status") {
    const pending = await getPendingAction(args.action_id);
    if (!pending) {
      return { status: "not_found", message: "Pending action not found." };
    }
    return {
      action_id: pending.id,
      status: pending.status,
      tool: pending.tool,
      result: pending.result ? JSON.parse(pending.result) : null,
      error: pending.error || null,
      createdAt: pending.createdAt,
      expiresAt: pending.expiresAt,
    };
  }

  const tokenInfo = await getValidAccessToken(
    apiKeyId,
    args.account_email || null,
  );
  const { account, status: authStatus, error: authError } = tokenInfo;

  if (!account || authStatus === "not_found") {
    const redirectUri = getCallbackUri(request);
    const host = request.headers.get("host") || "localhost:20127";
    const proto =
      request.headers.get("x-forwarded-proto") ||
      (host.startsWith("localhost") ? "http" : "https");
    const shortUrl = `${proto}://${host}/mcp/calendar/connect?k=${encodeURIComponent(apiKeyId)}`;

    const actionId = await savePendingAction({
      apiKeyId,
      tool: name,
      args,
      ttlMinutes: 15,
    });

    return {
      status: "auth_required",
      auth_url: shortUrl,
      message: `Cần xác thực Google Calendar. Hãy gửi link này cho người dùng bấm vào: ${shortUrl}`,
      action_id: actionId,
    };
  }

  if (
    authStatus === "auth_revoked" ||
    authStatus === "token_expired" ||
    authStatus === "refresh_failed"
  ) {
    const redirectUri = getCallbackUri(request);
    const actionId = await savePendingAction({
      apiKeyId,
      tool: name,
      args,
      ttlMinutes: 15,
    });
    const authUrl = buildAuthUrl({ apiKeyId, actionId, redirectUri });

    return {
      status: "token_expired",
      error_code: authStatus,
      account_email: account.email,
      message: `Phiên đăng nhập Google Calendar của tài khoản ${account.email} đã hết hạn hoặc bị hủy quyền (${authError || "refresh failed"}). Vui lòng bấm vào liên kết sau để đăng nhập lại:\n\n${authUrl}`,
      auth_url: authUrl,
      action_id: actionId,
      pending_tool: name,
    };
  }

  return executeCalendarToolDirect(account, name, args);
}
